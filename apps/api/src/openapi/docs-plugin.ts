import { createHash } from "node:crypto";

import fastifyApiReference from "@scalar/fastify-api-reference";
import type { FastifyPluginAsync } from "fastify";
import fastifyPlugin from "fastify-plugin";

import { generateOpenApiDocument } from "./generator.js";

/** Inline (no `src`) `<script>` elements; group 1 is the exact script text. */
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * CSP for the Scalar API-reference page — the API's only HTML surface, and so
 * the only response that gets more than the global lock-down policy (app.ts).
 * It allows exactly what the page uses:
 * - script-src: the bundle, served same-origin from node_modules at
 *   /docs/js/scalar.js, plus the inline `Scalar.createApiReference(...)`
 *   bootstrap pinned by its sha256 (hashed from the HTML actually sent, so a
 *   Scalar upgrade that changes the bootstrap stays covered) — no
 *   'unsafe-inline' / 'unsafe-eval' for scripts.
 * - style-src 'unsafe-inline': the bundle injects <style> elements and style
 *   attributes at runtime, with no nonce hook. Style injection can't run code.
 * - img-src data: blob: the "Test Request" client previews an image response
 *   (e.g. GET /api/v1/storage/:key) as <img src="blob:…"> over a data: SVG
 *   checkerboard; the UI's CSS icons are data: SVGs too.
 * - connect-src 'self': the ./openapi.json fetch and "Test Request" calls to
 *   this origin (the spec's only server is "/"). This also blocks the page's
 *   optional calls to Scalar's hosted services (agent, proxy, registry).
 * No font-src: the page uses system fonts (withDefaultFonts: false below).
 * Known, harmless report: zod (inside the bundle) probes `Function("")` in a
 * try/catch to pick a JIT path; it's refused (no 'unsafe-eval') and zod falls
 * back to its interpreter.
 */
function docsContentSecurityPolicy(html: string): string {
  const scriptHashes = [...html.matchAll(INLINE_SCRIPT)].map(
    ([, script = ""]) =>
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join(";");
}

const docsPlugin: FastifyPluginAsync = async (app) => {
  // Compute once at boot — the spec is deterministic given the code on disk.
  const document = generateOpenApiDocument();

  app.get("/openapi.json", async () => document);

  // Encapsulated so this hook only sees Scalar's routes (the HTML page, its JS
  // bundle and spec copies), never the rest of the API.
  await app.register(async (docs) => {
    docs.addHook("onSend", async (_req, reply, payload) => {
      const type = reply.getHeader("content-type");
      if (
        typeof payload === "string" &&
        typeof type === "string" &&
        type.startsWith("text/html")
      ) {
        // Replaces helmet's strict policy for this response only. Fail-closed:
        // anything that doesn't match here keeps the strict policy.
        reply.header(
          "content-security-policy",
          docsContentSecurityPolicy(payload),
        );
      }
      return payload;
    });

    await docs.register(fastifyApiReference, {
      routePrefix: "/docs",
      // Scalar 1.57+ uses configuration.content directly (not configuration.spec.content).
      configuration: {
        content: document,
        theme: "default",
        // The default fonts come from Scalar's font CDN — a third-party request
        // from a self-hosted (possibly air-gapped) install, and a font-src the
        // CSP would have to allow. System fonts instead.
        withDefaultFonts: false,
        // The AI agent (auto-on when served from localhost) calls Scalar's
        // hosted API and can upload this spec there. Off: nothing leaves the
        // install, and connect-src stays 'self' without violation noise.
        agent: { disabled: true },
      },
    });
  });
};

export default fastifyPlugin(docsPlugin, { name: "furan-docs" });
