import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/csp";

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe("buildContentSecurityPolicy", () => {
  const prod = directives(
    buildContentSecurityPolicy({
      nonce: "abc123",
      apiBase: "https://api.furan.example:8443",
      dev: false,
    }),
  );

  it("only runs scripts carrying the per-request nonce (+ what they load)", () => {
    expect(prod.get("script-src")).toEqual([
      "'self'",
      "'nonce-abc123'",
      "'strict-dynamic'",
    ]);
  });

  it("never allows eval or inline script in production", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "n",
      apiBase: "/api",
      dev: false,
    });
    expect(csp).not.toContain("unsafe-eval");
    expect(prod.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("forbids framing, plugins, base-tag hijack and off-site form posts", () => {
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
    expect(prod.get("object-src")).toEqual(["'none'"]);
    expect(prod.get("base-uri")).toEqual(["'self'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
    expect(prod.get("default-src")).toEqual(["'self'"]);
  });

  it("lets the browser reach a cross-origin api (fetch + SSE) by origin only", () => {
    expect(prod.get("connect-src")).toEqual([
      "'self'",
      "blob:",
      "https://api.furan.example:8443",
    ]);
  });

  it("adds nothing for a same-origin (relative) api base", () => {
    const rel = directives(
      buildContentSecurityPolicy({ nonce: "n", apiBase: "/api", dev: false }),
    );
    expect(rel.get("connect-src")).toEqual(["'self'", "blob:"]);
  });

  it("allows blob:/data: images and blob: fetches (authed screenshots → object URLs)", () => {
    expect(prod.get("img-src")).toEqual(["'self'", "blob:", "data:"]);
    expect(prod.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("relaxes only what `next dev` needs (eval for fast refresh, HMR socket)", () => {
    const dev = directives(
      buildContentSecurityPolicy({
        nonce: "n",
        apiBase: "http://localhost:3000",
        dev: true,
      }),
    );
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toEqual([
      "'self'",
      "blob:",
      "http://localhost:3000",
      "ws:",
    ]);
    expect(dev.get("frame-ancestors")).toEqual(["'none'"]);
  });
});
