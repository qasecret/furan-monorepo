import { createHash } from "node:crypto";

export function objectKey(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
