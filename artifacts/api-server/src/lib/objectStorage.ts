import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";
import { S3StorageClient, isS3Configured } from "./s3ObjectStorage";
import type { StorageFile, StorageLike } from "./storage-types";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// ── Storage driver selection ────────────────────────────────────────────────
// "gcs" → Replit object storage via the local sidecar (original behaviour).
// "s3"  → DigitalOcean Spaces / any S3-compatible endpoint (local + DO prod).
// Default: infer "s3" when S3/Spaces env is present, else "gcs".
type StorageDriver = "s3" | "gcs";

function resolveStorageDriver(env: Record<string, string | undefined> = process.env): StorageDriver {
  const explicit = (env.STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (["s3", "do", "do-spaces", "spaces"].includes(explicit)) return "s3";
  if (["gcs", "replit", "google"].includes(explicit)) return "gcs";
  return isS3Configured(env) ? "s3" : "gcs";
}

export const storageDriver: StorageDriver = resolveStorageDriver();

// Kept around for presigning + URL normalization when the S3 driver is active.
const s3Client: S3StorageClient | null = storageDriver === "s3" ? new S3StorageClient() : null;

function createGcsClient(): StorageLike {
  // The GCS SDK is structurally compatible with the slice of StorageLike the
  // app uses (its methods return wider tuples we only read `[0]` of), so the
  // cast is safe; it is the single seam where the concrete SDK meets the
  // abstraction. Construction is side-effect-free until a request is made.
  return new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  }) as unknown as StorageLike;
}

export const objectStorageClient: StorageLike =
  storageDriver === "s3" ? (s3Client as StorageLike) : createGcsClient();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StorageFile | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: StorageFile, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(tenantId?: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const uploadSubpath = tenantId
      ? `tenants/${tenantId}/uploads/${objectId}`
      : `uploads/${objectId}`;
    const fullPath = `${privateObjectDir}/${uploadSubpath}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Server-side upload: write file bytes straight to object storage from the
   * API process and return the normalized `/objects/...` path.
   *
   * This is the fallback path the browser uploader uses when the direct
   * browser → storage PUT is blocked (e.g. a Spaces bucket without a CORS rule
   * for the local dev origin). The bytes transit the API instead of going
   * straight to the bucket, so no CORS preflight is involved. The resulting
   * object key is identical to what the presigned-PUT flow would have produced,
   * so downstream reads (`getObjectEntityFile`) and cleanup sweeps are unchanged.
   */
  async uploadObjectEntityFromBuffer(
    data: Buffer,
    opts: { contentType?: string; tenantId?: string } = {},
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var.",
      );
    }

    const objectId = randomUUID();
    const uploadSubpath = opts.tenantId
      ? `tenants/${opts.tenantId}/uploads/${objectId}`
      : `uploads/${objectId}`;
    const fullPath = `${privateObjectDir}/${uploadSubpath}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    await bucket.file(objectName).save(data, { contentType: opts.contentType });

    // Mirror normalizeObjectEntityPath()'s output for the presigned flow so the
    // stored storagePath is consistent regardless of which upload path was used.
    return `/objects/${uploadSubpath}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<StorageFile> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  /** Parse PRIVATE_OBJECT_DIR ("/bucket[/prefix]") into its bucket + prefix. */
  private getPrivateDirParts(): { bucket: string; prefix: string } {
    const raw = this.getPrivateObjectDir().replace(/^\//, "").replace(/\/$/, "");
    const parts = raw.split("/");
    return { bucket: parts[0], prefix: parts.slice(1).join("/") };
  }

  normalizeObjectEntityPath(rawPath: string): string {
    // S3 driver: convert a presigned/public Spaces URL back to /objects/<id>.
    if (storageDriver === "s3" && s3Client) {
      const { bucket, prefix } = this.getPrivateDirParts();
      const normalized = s3Client.normalizeUrlToObjectPath(rawPath, bucket, prefix);
      if (normalized) return normalized;
      return rawPath;
    }

    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StorageFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  // S3 driver: presign directly with the AWS SDK (no Replit sidecar). Only PUT
  // (upload) is used by the app today.
  if (storageDriver === "s3" && s3Client) {
    if (method !== "PUT") {
      throw new Error(`S3 signObjectURL only supports PUT, got ${method}`);
    }
    return s3Client.presignPutUrl(bucketName, objectName, ttlSec);
  }

  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = (await response.json()) as { signed_url: string };
  return signedURL;
}
