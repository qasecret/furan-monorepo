import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type { HeadResult, Storage } from "./types.js";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

/**
 * S3-backed Storage. Works against AWS S3 and MinIO (the dev compose data
 * plane uses MinIO with `forcePathStyle: true`).
 *
 * Multipart uploads use 8 MiB parts via `@aws-sdk/lib-storage`. Single-shot
 * `put` is used for screenshots + DOM snapshots; multipart kicks in for
 * larger artifacts (e.g. archival exports).
 */
export function createS3Storage(config: S3Config): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async putMultipart(key, body, contentType) {
      await new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        },
        partSize: 8 * 1024 * 1024,
      }).done();
    },
    async get(key) {
      const r = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      const body = r.Body as { transformToByteArray(): Promise<Uint8Array> };
      return body.transformToByteArray();
    },
    async head(key) {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        const result: HeadResult = { size: r.ContentLength ?? 0 };
        if (r.ContentType !== undefined) result.contentType = r.ContentType;
        return result;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "NotFound" || name === "NoSuchKey") return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    },
  };
}
