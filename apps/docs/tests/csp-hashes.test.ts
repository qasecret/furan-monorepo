import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inlineScriptHashes,
  unsafeInlineFindings,
  writeCspHashes,
} from "../scripts/csp-hashes.mjs";

const sha = (body: string): string =>
  `'sha256-${createHash("sha256").update(body).digest("base64")}'`;

const dirs: string[] = [];
async function buildDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "csp-hashes-"));
  dirs.push(dir);
  for (const [name, html] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), html);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("inlineScriptHashes", () => {
  it("hashes inline scripts and skips src= scripts", () => {
    expect(
      inlineScriptHashes('<script>a()</script><script src="/x.js"></script>'),
    ).toEqual([sha("a()")]);
  });

  it("hashes the body byte-exact, attributes aside", () => {
    expect(
      inlineScriptHashes('<script type="module">\n  b();\n</script>'),
    ).toEqual([sha("\n  b();\n")]);
  });

  it("skips data blocks the browser never runs (JSON-LD), keeps JS types", () => {
    expect(
      inlineScriptHashes(
        '<script type="application/ld+json">{"a":1}</script>' +
          '<script type="module">m()</script>' +
          '<script type="text/javascript">t()</script>',
      ),
    ).toEqual([sha("m()"), sha("t()")]);
  });

  it("keeps one entry per script in document order", () => {
    expect(
      inlineScriptHashes("<script>a()</script><script>a()</script>"),
    ).toEqual([sha("a()"), sha("a()")]);
  });
});

describe("unsafeInlineFindings", () => {
  it("flags an inline event handler", () => {
    expect(unsafeInlineFindings('<button onclick="x()">')).toHaveLength(1);
  });

  it("flags a javascript: URL", () => {
    expect(unsafeInlineFindings('<a href="javascript:void(0)">')).toHaveLength(
      1,
    );
  });

  it("ignores handler-looking text outside tags", () => {
    expect(unsafeInlineFindings("<p>onclick= in text</p>")).toHaveLength(0);
  });
});

describe("writeCspHashes", () => {
  it("writes the sorted, de-duplicated hashes of every page", async () => {
    const dir = await buildDir({
      "index.html": "<script>z()</script><script>a()</script>",
      "guide/page.html": "<script>a()</script>",
      "assets/x.js": "<script>not html</script>",
    });
    const hashes = await writeCspHashes(dir);
    const expected = [sha("a()"), sha("z()")].sort();
    expect(hashes).toEqual(expected);
    const file = JSON.parse(
      await readFile(path.join(dir, "csp-hashes.json"), "utf8"),
    ) as { scriptHashes: string[] };
    expect(file.scriptHashes).toEqual(expected);
  });

  it("rejects a page with an inline handler, naming the file", async () => {
    const dir = await buildDir({
      "ok.html": "<script>a()</script>",
      "bad/page.html": '<img src="x.png" onload="go()">',
    });
    await expect(writeCspHashes(dir)).rejects.toThrow(/bad\/page\.html/);
  });
});
