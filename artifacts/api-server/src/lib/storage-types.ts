/**
 * Storage backend abstraction.
 *
 * The codebase historically used the Google Cloud Storage SDK directly
 * (`objectStorageClient.bucket(name).file(obj)`), which only works inside
 * Replit (it authenticates through the Replit sidecar at 127.0.0.1:1106).
 *
 * To run off-Replit (locally and on DigitalOcean) we introduce a small
 * `StorageLike` interface covering exactly the slice of the GCS surface the
 * app uses, plus an S3-compatible implementation (DigitalOcean Spaces / any
 * S3 endpoint) in `s3ObjectStorage.ts`. `objectStorage.ts` selects the backend
 * at runtime via the `STORAGE_DRIVER` env var.
 *
 * The method signatures deliberately mirror the GCS SDK's tuple-returning
 * shape (`exists()` → `[boolean]`, `download()` → `[Buffer]`, etc.) so every
 * existing call site — pipeline.ts, sidecar-client.ts, guestCleanup.ts and the
 * routes — keeps compiling and running unchanged regardless of backend.
 */

import type { Readable } from "stream";

/** Subset of GCS `FileMetadata` the app reads. */
export interface StorageObjectMetadata {
  contentType?: string;
  /** GCS returns size as a string; S3 as a number. Callers `Number(...)` it. */
  size?: string | number;
  /** Custom user metadata. ACL policy is stored under `custom:aclPolicy`. */
  metadata?: Record<string, string | undefined>;
}

export interface StorageSaveOptions {
  contentType?: string;
  resumable?: boolean;
}

export interface StorageDeleteOptions {
  ignoreNotFound?: boolean;
}

/** A single object. Mirrors the used slice of the GCS `File` API. */
export interface StorageFile {
  /** The object name (key) within its bucket. */
  readonly name: string;
  exists(): Promise<[boolean]>;
  download(): Promise<[Buffer]>;
  createReadStream(): Readable;
  save(data: Buffer, options?: StorageSaveOptions): Promise<void>;
  getMetadata(): Promise<[StorageObjectMetadata]>;
  setMetadata(metadata: { metadata?: Record<string, string | undefined>; contentType?: string }): Promise<unknown>;
  delete(options?: StorageDeleteOptions): Promise<unknown>;
}

export interface StorageGetFilesOptions {
  prefix?: string;
}

/** A bucket handle. Mirrors the used slice of the GCS `Bucket` API. */
export interface StorageBucket {
  file(objectName: string): StorageFile;
  getFiles(options?: StorageGetFilesOptions): Promise<[StorageFile[]]>;
}

/** Top-level client. Mirrors the used slice of the GCS `Storage` API. */
export interface StorageLike {
  bucket(name: string): StorageBucket;
}
