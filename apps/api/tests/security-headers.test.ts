import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "./helpers.js";

// Every API response carries a lock-down CSP: JSON, images and SSE need no
// sources, and it neutralizes any response a browser might render as HTML.
const STRICT_CSP =
  "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'";

/** Parse a CSP header into `directive → sources[]`. */
function parseCsp(header: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of String(header).split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe("security headers", () => {
  let h: TestApp;
  beforeAll(async () => {
    // createStorage() needs S3 settings at boot; none of these cases fetch bytes.
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  test("JSON routes carry the strict CSP", async () => {
    for (const url of ["/livez", "/openapi.json", "/users/me"]) {
      const res = await h.app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(STRICT_CSP);
    }
  });

  test("an unmatched route (404) carries the strict CSP", async () => {
    const res = await h.app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-security-policy"]).toBe(STRICT_CSP);
  });

  test("the storage proxy carries the strict CSP", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/storage/${"a".repeat(64)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-security-policy"]).toBe(STRICT_CSP);
  });

  test("the other helmet defaults are unchanged", async () => {
    const res = await h.app.inject({ method: "GET", url: "/livez" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });

  describe("Scalar docs page", () => {
    test("/docs redirects to /docs/ under the strict CSP", async () => {
      const res = await h.app.inject({ method: "GET", url: "/docs" });
      expect(res.statusCode).toBe(301);
      expect(res.headers["content-security-policy"]).toBe(STRICT_CSP);
    });

    test("/docs/ gets the docs CSP, not the strict one", async () => {
      const res = await h.app.inject({ method: "GET", url: "/docs/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);

      const header = res.headers["content-security-policy"];
      expect(header).not.toBe(STRICT_CSP);
      const csp = parseCsp(header);

      // Still locked down by default, never frameable, no <base>/<form> games.
      expect(csp.get("default-src")).toEqual(["'none'"]);
      expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
      expect(csp.get("base-uri")).toEqual(["'none'"]);
      expect(csp.get("form-action")).toEqual(["'none'"]);

      // Scripts: the same-origin bundle + the exact inline bootstrap, by hash —
      // no 'unsafe-inline' / 'unsafe-eval'.
      const inline = [
        ...res.body.matchAll(
          /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi,
        ),
      ].map((m) => m[1] ?? "");
      expect(inline.length).toBeGreaterThan(0);
      const hashes = inline.map(
        (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`,
      );
      expect(csp.get("script-src")).toEqual(["'self'", ...hashes]);
      expect(String(header)).not.toContain("unsafe-eval");

      // Runtime-injected styles; image-response previews (blob:) + data: icons.
      expect(csp.get("style-src")).toEqual(["'unsafe-inline'"]);
      expect(csp.get("img-src")).toEqual(["data:", "blob:"]);

      // The spec is fetched same-origin (./openapi.json); no third-party hosts.
      expect(csp.get("connect-src")).toEqual(["'self'"]);
      expect(String(header)).not.toMatch(/https?:/);
    });

    test("the bundle + spec under /docs/ keep the strict CSP", async () => {
      for (const url of ["/docs/js/scalar.js", "/docs/openapi.json"]) {
        const res = await h.app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers["content-security-policy"], url).toBe(STRICT_CSP);
      }
    });

    test("the page opts out of Scalar's hosted fonts + AI agent", async () => {
      // Both reach third-party hosts from a self-hosted install (and would need
      // a wider CSP); the page uses system fonts and no agent instead.
      const res = await h.app.inject({ method: "GET", url: "/docs/" });
      expect(res.body).toContain('"withDefaultFonts": false');
      expect(res.body).toMatch(/"agent": \{\s*"disabled": true\s*\}/);
    });
  });
});
