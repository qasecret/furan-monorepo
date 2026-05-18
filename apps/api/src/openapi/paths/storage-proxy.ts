import { z } from "zod";

import { paramsSchema } from "../../routes/storage-proxy.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerStorageProxyPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/api/v1/storage/{key}",
    summary:
      "Authenticated proxy for stored image bytes. Key is sha256 hex of content (content-addressed storage).",
    tags: ["storage"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsSchema },
    responses: {
      200: {
        description:
          "Image bytes. Content-Type is sniffed (image/png, image/webp, or image/jpeg).",
        content: {
          "image/png": {
            schema: z.string().openapi({ type: "string", format: "binary" }),
          },
          "image/webp": {
            schema: z.string().openapi({ type: "string", format: "binary" }),
          },
          "image/jpeg": {
            schema: z.string().openapi({ type: "string", format: "binary" }),
          },
        },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Key not found, malformed, or storage backend error",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
