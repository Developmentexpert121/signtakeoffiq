/**
 * S3-compatible storage backend (DigitalOcean Spaces, AWS S3, MinIO, …).
 *
 * Implements the `StorageLike` interface from `storage-types.ts` so it is a
 * drop-in replacement for the Replit/GCS client used by pipeline.ts,
 * sidecar-client.ts, guestCleanup.ts and the routes — no call site changes.
 *
 * Selected by `objectStorage.ts` when `STORAGE_DRIVER=s3` (or when DO Spaces /
 * S3 env vars are present). Configuration (env, with `DO_SPACES_*` aliases):
 *   S3_ENDPOINT           e.g. https://nyc3.digitaloceanspaces.com   (DO_SPACES_ENDPOINT)
 *   S3_REGION             e.g. nyc3                                  (DO_SPACES_REGION)
 *   S3_ACCESS_KEY_ID                                                 (DO_SPACES_KEY)
 *   S3_SECRET_ACCESS_KEY                                             (DO_SPACES_SECRET)
 *   S3_FORCE_PATH_STYLE   "true" to use path-style URLs (default: virtual-hosted)
 * The bucket + optional prefix still come from PRIVATE_OBJECT_DIR (/bucket[/prefix]).
 */

import { PassThrough, type Readable } from "stream";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ACL_POLICY_METADATA_KEY } from "./objectAcl";
import type {
  StorageLike,
  StorageBucket,
  StorageFile,
  StorageObjectMetadata,
  StorageSaveOptions,
  StorageDeleteOptions,
  StorageGetFilesOptions,
} from "./storage-types";

type Env = Record<string, string | undefined>;

// S3 user-metadata keys must be valid HTTP header tokens (lower-case, no ':'),
// so the ACL policy is stored under this key and re-exposed to the app under
// ACL_POLICY_METADATA_KEY ("custom:aclPolicy") by getMetadata().
const S3_META_ACL_KEY = "aclpolicy";

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Resolve S3 config from env, accepting both S3_* and DO_SPACES_* names. */
export function resolveS3Config(env: Env): S3Config | null {
  const endpoint = env.S3_ENDPOINT ?? env.DO_SPACES_ENDPOINT;
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.DO_SPACES_KEY;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.DO_SPACES_SECRET;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const region = env.S3_REGION ?? env.DO_SPACES_REGION ?? "us-east-1";
  const forcePathStyle =
    (env.S3_FORCE_PATH_STYLE ?? env.DO_SPACES_FORCE_PATH_STYLE ?? "").toLowerCase() === "true";
  return { endpoint, region, accessKeyId, secretAccessKey, forcePathStyle };
}

/** True when enough env is present to build an S3 client. */
export function isS3Configured(env: Env): boolean {
  return resolveS3Config(env) !== null;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.$metadata?.httpStatusCode === 404 ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey"
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

class S3File implements StorageFile {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
    public readonly name: string,
  ) {}

  async exists(): Promise<[boolean]> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: this.name }));
      return [true];
    } catch (err) {
      if (isNotFound(err)) return [false];
      throw err;
    }
  }

  async download(): Promise<[Buffer]> {
    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: this.name }),
    );
    const buf = await streamToBuffer(resp.Body as Readable);
    return [buf];
  }

  createReadStream(): Readable {
    // GCS exposes a synchronous createReadStream(); S3 GetObject is async, so we
    // return a PassThrough immediately and pipe the object body into it once the
    // request resolves, forwarding any error to the stream consumer.
    const pass = new PassThrough();
    this.client
      .send(new GetObjectCommand({ Bucket: this.bucketName, Key: this.name }))
      .then((resp) => {
        const body = resp.Body as Readable;
        body.on("error", (e) => pass.destroy(e));
        body.pipe(pass);
      })
      .catch((e) => pass.destroy(e instanceof Error ? e : new Error(String(e))));
    return pass;
  }

  async save(data: Buffer, options?: StorageSaveOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.name,
        Body: data,
        ContentType: options?.contentType,
      }),
    );
  }

  async getMetadata(): Promise<[StorageObjectMetadata]> {
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucketName, Key: this.name }),
    );
    const metadata: Record<string, string | undefined> = {};
    const acl = head.Metadata?.[S3_META_ACL_KEY];
    if (acl !== undefined) {
      metadata[ACL_POLICY_METADATA_KEY] = acl;
    }
    return [
      {
        contentType: head.ContentType,
        size: head.ContentLength,
        metadata,
      },
    ];
  }

  async setMetadata(meta: {
    metadata?: Record<string, string | undefined>;
    contentType?: string;
  }): Promise<unknown> {
    // S3 has no in-place metadata update; a self-copy with MetadataDirective
    // REPLACE rewrites the object's user metadata (and content type).
    let contentType = meta.contentType;
    if (!contentType) {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucketName, Key: this.name }),
        );
        contentType = head.ContentType;
      } catch {
        // Non-fatal — fall through with undefined content type.
      }
    }

    const s3Metadata: Record<string, string> = {};
    const incoming = meta.metadata ?? {};
    const acl = incoming[ACL_POLICY_METADATA_KEY];
    if (acl !== undefined) {
      s3Metadata[S3_META_ACL_KEY] = acl;
    }

    const copySource = `${this.bucketName}/${this.name}`
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    return this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        Key: this.name,
        CopySource: copySource,
        MetadataDirective: "REPLACE",
        Metadata: s3Metadata,
        ContentType: contentType,
      }),
    );
  }

  async delete(options?: StorageDeleteOptions): Promise<unknown> {
    try {
      return await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: this.name }),
      );
    } catch (err) {
      if (options?.ignoreNotFound && isNotFound(err)) return undefined;
      throw err;
    }
  }
}

class S3Bucket implements StorageBucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {}

  file(objectName: string): StorageFile {
    return new S3File(this.client, this.bucketName, objectName);
  }

  async getFiles(options?: StorageGetFilesOptions): Promise<[StorageFile[]]> {
    const files: StorageFile[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: options?.prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (obj.Key) files.push(new S3File(this.client, this.bucketName, obj.Key));
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return [files];
  }
}

export class S3StorageClient implements StorageLike {
  private readonly client: S3Client;
  private readonly config: S3Config;

  constructor(env: Env = process.env as Env) {
    const config = resolveS3Config(env);
    if (!config) {
      throw new Error(
        "S3 storage selected but not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID and " +
          "S3_SECRET_ACCESS_KEY (or the DO_SPACES_* equivalents).",
      );
    }
    this.config = config;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Recent AWS SDK v3 defaults to adding a CRC32 checksum to every PutObject
      // (WHEN_SUPPORTED). For presigned uploads that injects an
      // `x-amz-sdk-checksum-algorithm=CRC32` query param and expects the browser
      // to send a matching `x-amz-checksum-crc32` header — which our plain
      // Content-Type-only PUT doesn't. DigitalOcean Spaces (and other
      // S3-compatible stores) then reject/preflight-fail the upload. Forcing
      // WHEN_REQUIRED keeps presigned PUT URLs clean and compatible.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  bucket(name: string): StorageBucket {
    return new S3Bucket(this.client, name);
  }

  /**
   * Presign a PUT URL the browser uploads to directly. Content-Type is left
   * unsigned so the client may send any `Content-Type` header without breaking
   * the SigV4 signature (S3/Spaces still records it on the object).
   */
  async presignPutUrl(bucketName: string, objectName: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: bucketName, Key: objectName }),
      { expiresIn: ttlSec },
    );
  }

  /**
   * Convert a presigned/public S3 URL back to the app's `/objects/<entityId>`
   * reference, mirroring `ObjectStorageService.normalizeObjectEntityPath`.
   *
   * Returns null when `rawUrl` is not an S3 URL for the configured endpoint, so
   * the caller can fall back to its existing handling.
   *
   * @param privateBucket  bucket parsed from PRIVATE_OBJECT_DIR
   * @param privatePrefix  optional prefix parsed from PRIVATE_OBJECT_DIR ("" if none)
   */
  normalizeUrlToObjectPath(
    rawUrl: string,
    privateBucket: string,
    privatePrefix: string,
  ): string | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    const endpointHost = (() => {
      try {
        return new URL(this.config.endpoint).host;
      } catch {
        return "";
      }
    })();
    const host = url.host;
    const isEndpointHost = host === endpointHost;
    const isVirtualHosted = host === `${privateBucket}.${endpointHost}`;
    if (!isEndpointHost && !isVirtualHosted) return null;

    // Strip leading slash → either "<key>" (virtual-hosted) or "<bucket>/<key>"
    // (path-style / forcePathStyle).
    let objectKey = url.pathname.replace(/^\//, "");
    if (isEndpointHost && objectKey.startsWith(`${privateBucket}/`)) {
      objectKey = objectKey.slice(privateBucket.length + 1);
    }
    objectKey = decodeURIComponent(objectKey);

    const prefix = privatePrefix ? `${privatePrefix}/` : "";
    const entityId = objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;
    return `/objects/${entityId}`;
  }
}
