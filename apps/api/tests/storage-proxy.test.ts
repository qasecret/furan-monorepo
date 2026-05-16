import { createStorage, objectKey } from "@furan/storage";
import { describe, expect, test } from "vitest";

import { createTestApp } from "./helpers.js";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY;
const d = skip ? describe.skip : describe;

// Minimal but valid 1×1 PNG (decodes cleanly + carries proper magic bytes).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

d("GET /api/v1/storage/:key", () => {
  test("returns the bytes + image/png content-type for an authenticated user", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      const userId = "00000000-0000-0000-0000-000000000099";
      const token = h.app.jwt.sign({ sub: userId, role: "editor" });

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["cache-control"]).toContain("max-age=300");
      expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("returns 404 for a nonexistent key", async () => {
    const h = await createTestApp();
    try {
      const userId = "00000000-0000-0000-0000-000000000099";
      const token = h.app.jwt.sign({ sub: userId, role: "editor" });
      const fakeKey = "0".repeat(64);

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${fakeKey}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test("returns 401 when unauthenticated", async () => {
    const h = await createTestApp();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${"0".repeat(64)}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  test("returns 404 for a malformed (non-sha256) key", async () => {
    const h = await createTestApp();
    try {
      const userId = "00000000-0000-0000-0000-000000000099";
      const token = h.app.jwt.sign({ sub: userId, role: "editor" });
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/not-a-real-key`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
