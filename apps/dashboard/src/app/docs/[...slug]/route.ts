import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * An unknown /docs path (ADR-081). next.config.mjs rewrites /docs/x to the
 * portal's public/docs/x.html (afterFiles); when no such file exists the
 * rewritten path lands here, and the reader gets the portal's own 404 page —
 * inside the docs, with its search and sidebar — not the dashboard's, whose
 * inline scripts need the nonce the /docs pages never get (the /docs policy is
 * hash-based, from next.config.mjs).
 *
 * The working directory is apps/dashboard both in `next dev` and in the
 * standalone image (server.js chdirs there), where public/ is copied.
 */
export async function GET(): Promise<Response> {
  const file = path.join(process.cwd(), "public", "docs", "404.html");
  const page = await readFile(file, "utf8").catch(() => null);
  if (page === null) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(page, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
