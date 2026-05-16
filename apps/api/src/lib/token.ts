import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "furan_pat_";
export const TOKEN_BODY_LENGTH = 32;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface GeneratedToken {
  raw: string;
  hash: string;
}

export function generateRawToken(): GeneratedToken {
  const bytes = randomBytes(TOKEN_BODY_LENGTH);
  let body = "";
  for (const b of bytes) body += BASE62[b % 62];
  const raw = `${TOKEN_PREFIX}${body}`;
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isPatFormat(value: string): boolean {
  return (
    value.startsWith(TOKEN_PREFIX) &&
    value.length === TOKEN_PREFIX.length + TOKEN_BODY_LENGTH
  );
}
