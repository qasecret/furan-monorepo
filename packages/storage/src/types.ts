export interface HeadResult {
  size: number;
  contentType?: string;
}

/**
 * Storage backend interface — same shape for both S3 and on-disk (HDD)
 * implementations. Consumers only care about keys + bytes; the factory
 * (`createStorage()` in `client.ts`) picks the impl based on
 * `STORAGE_KIND`.
 *
 * `putMultipart` is a hint: S3 uses 8 MiB chunked upload via the AWS
 * `@aws-sdk/lib-storage` Upload helper, which streams large bodies
 * without holding them whole in memory. HDD does a single fs.writeFile
 * — chunking buys nothing on local disk.
 *
 * `head` returns null (not throw) for the missing-object case so
 * retention/cleanup paths can probe without try/catch nests.
 *
 * Spec: furan-design/specs/2026-05-24-hdd-storage-backend-design.md
 */
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
