// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/docs/[...slug]/route";

// An unknown /docs path must get the portal's own 404 page, which passes the
// /docs hash CSP, not the dashboard's (its inline scripts need a nonce the
// docs pages never get).
const dirs: string[] = [];
function serveFrom(files: Record<string, string>): void {
  const dir = mkdtempSync(path.join(tmpdir(), "docs-404-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GET /docs/[...slug] (unknown docs path)", () => {
  it("answers 404 with the portal's 404 page", async () => {
    serveFrom({
      "public/docs/404.html": "<html><title>Page Not Found</title></html>",
    });
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Page Not Found");
  });

  it("answers a plain 404 when the docs aren't built", async () => {
    serveFrom({});
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});
