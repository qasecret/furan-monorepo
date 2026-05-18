import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";
import stringify from "json-stable-stringify";
import { afterAll, describe, expect, test } from "vitest";

import { generateOpenApiDocument } from "../src/openapi/generator.js";

import { createTestApp, type TestApp } from "./helpers.js";

const snapshotPath = fileURLToPath(
  new URL("../openapi.snapshot.json", import.meta.url),
);

describe("openapi", () => {
  test("snapshot is up to date (run `pnpm --filter @furan/api openapi:snapshot` to refresh)", () => {
    const current = stringify(generateOpenApiDocument(), { space: 2 });
    const snapshot = readFileSync(snapshotPath, "utf8").replace(/\n$/, "");
    expect(current).toBe(snapshot);
  });

  test("is valid OpenAPI 3.1", async () => {
    const doc = generateOpenApiDocument();
    // structuredClone because SwaggerParser mutates its input
    await SwaggerParser.validate(
      structuredClone(doc) as unknown as Parameters<
        typeof SwaggerParser.validate
      >[0],
    );
  });

  test("every authed path declares bearerAuth and a 401 response", () => {
    const doc = generateOpenApiDocument();
    const exemptions = new Set<string>([
      "/livez",
      "/readyz",
      "/metrics",
      "/auth/login",
      "/_telemetry/sdk",
    ]);
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      if (exemptions.has(path)) continue;
      for (const [verb, op] of Object.entries(methods ?? {})) {
        if (verb === "parameters" || op == null || typeof op !== "object")
          continue;
        const operation = op as {
          security?: unknown;
          responses?: Record<string, unknown>;
        };
        expect(
          operation.security,
          `${verb.toUpperCase()} ${path} security`,
        ).toEqual([{ bearerAuth: [] }]);
        expect(
          operation.responses,
          `${verb.toUpperCase()} ${path} responses`,
        ).toHaveProperty("401");
      }
    }
  });

  test("multipart upload path declares multipart/form-data", () => {
    const doc = generateOpenApiDocument();
    const op = doc.paths?.["/runs/{runId}/screenshots"] as
      | { post?: { requestBody?: { content?: Record<string, unknown> } } }
      | undefined;
    expect(op?.post?.requestBody?.content).toBeDefined();
    expect(op?.post?.requestBody?.content).toHaveProperty(
      "multipart/form-data",
    );
  });

  describe("smoke (boots Fastify)", () => {
    let testApp: TestApp | null = null;

    afterAll(async () => {
      if (testApp) await testApp.close();
    });

    test("GET /openapi.json returns 200 and parses", async () => {
      // Provide S3 defaults so createStorage() doesn't throw when MinIO isn't
      // wired — the smoke tests only exercise /openapi.json and /docs, which
      // don't touch storage at runtime.
      process.env.S3_ENDPOINT ??= "http://localhost:9000";
      process.env.S3_BUCKET ??= "furan-dev";
      process.env.S3_ACCESS_KEY ??= "furan";
      process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
      testApp ??= await createTestApp();
      const res = await testApp.app.inject({
        method: "GET",
        url: "/openapi.json",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { openapi: string };
      expect(body.openapi).toBe("3.1.0");
    });

    test("GET /docs returns 200 (Scalar HTML)", async () => {
      testApp ??= await createTestApp();
      // Scalar registers the HTML at /docs/ — /docs redirects (301) to /docs/
      const res = await testApp.app.inject({ method: "GET", url: "/docs/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });
  });
});
