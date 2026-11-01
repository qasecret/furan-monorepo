// Post-build step for the docs portal (spec §5.2, ADR-080).
//
// The dashboard serves the built portal at /docs under a static
// Content-Security-Policy with no 'unsafe-inline' for scripts, so every inline
// <script> Docusaurus emits must be allowed by its hash. This walks the build,
// hashes each inline script body, and writes build/csp-hashes.json, which
// apps/dashboard/next.config.mjs turns into the /docs policy.
//
// An inline event handler (onload=…) or a javascript: URL can't be allowed by
// a hash without 'unsafe-hashes', so either one fails the build instead of
// shipping a page the policy breaks.
//
// Usage: node scripts/csp-hashes.mjs <build-dir>

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const HAS_SRC = /\bsrc\s*=/i;
const TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
// A <script> with another type (JSON-LD breadcrumbs on every page) is a data
// block: the browser never runs it and script-src never checks it.
const JS_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);
const runs = (attrs) => {
  const type = attrs.match(TYPE)?.[1];
  return type === undefined || JS_TYPES.has(type.toLowerCase());
};
// Script/style bodies and comments are stripped before looking at tags, so
// code or prose that happens to contain "<a onclick=" is not a tag.
const NOT_MARKUP =
  /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi;
const TAG = /<[a-z][^>]*>/gi;
const HANDLER = /\son[a-z]+\s*=/i;
const JS_URL = /\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i;

/**
 * The CSP source for each inline script body, in document order.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const [, attrs, body] of html.matchAll(SCRIPT)) {
    if (HAS_SRC.test(attrs) || !runs(attrs)) continue;
    const digest = createHash("sha256").update(body).digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * Tags carrying inline script a hash can't cover: event handlers and
 * javascript: URLs.
 * @param {string} html
 * @returns {string[]}
 */
export function unsafeInlineFindings(html) {
  const markup = html.replace(NOT_MARKUP, "");
  return [...markup.matchAll(TAG)]
    .map(([tag]) => tag)
    .filter((tag) => HANDLER.test(tag) || JS_URL.test(tag));
}

/**
 * Hash every page under `buildDir` and write `csp-hashes.json` there.
 * @param {string} buildDir
 * @returns {Promise<string[]>} the sorted, de-duplicated hashes
 */
export async function writeCspHashes(buildDir) {
  const pages = (await readdir(buildDir, { recursive: true }))
    .filter((name) => name.endsWith(".html"))
    .sort();
  const hashes = new Set();
  const problems = [];
  for (const page of pages) {
    const html = await readFile(path.join(buildDir, page), "utf8");
    for (const finding of unsafeInlineFindings(html)) {
      problems.push(`${page}: ${finding}`);
    }
    for (const hash of inlineScriptHashes(html)) hashes.add(hash);
  }
  if (problems.length > 0) {
    throw new Error(
      `Inline script a CSP hash can't allow:\n${problems.join("\n")}`,
    );
  }
  const scriptHashes = [...hashes].sort();
  await writeFile(
    path.join(buildDir, "csp-hashes.json"),
    `${JSON.stringify({ scriptHashes }, null, 2)}\n`,
  );
  return scriptHashes;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/csp-hashes.mjs <build-dir>");
    process.exit(1);
  }
  try {
    const hashes = await writeCspHashes(path.resolve(dir));
    console.log(`csp-hashes: ${hashes.length} inline script hash(es)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
