import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getEnv } from "@furan/config";
import { z } from "zod";

const storageEnv = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
});

export interface HeadResult {
  size: number;
  contentType?: string;
}

export interface Storage {
  put(
    key: string,
    body: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  putMultipart(
    key: string,
    body: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
}

export function createStorage(): Storage {
  const env = getEnv(storageEnv);
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
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
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
        },
        partSize: 8 * 1024 * 1024,
      }).done();
    },
    async get(key) {
      const r = await client.send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
      const body = r.Body as { transformToByteArray(): Promise<Uint8Array> };
      return body.transformToByteArray();
    },
    async head(key) {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
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
        new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
    },
  };
}
