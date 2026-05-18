import { z } from "zod";

import { paramsSchema } from "../../routes/run-events.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerRunEventsPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/api/v1/runs/{id}/events",
    summary:
      "Server-Sent Events stream for a run. Emits `event: progress` frames with JSON payloads carrying `{ event, runId, ...details }`. Sends a `:` keep-alive every 15s.",
    description:
      "Long-lived response (`text/event-stream`). Connection closes when the client disconnects.",
    tags: ["sse"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsSchema },
    responses: {
      200: {
        description: "SSE stream of run events",
        content: {
          "text/event-stream": {
            schema: z
              .string()
              .describe(
                "SSE frames in the format `event: progress\\ndata: <JSON>\\n\\n`. Keep-alive comments `:\\n\\n` sent every 15s.",
              ),
          },
        },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      403: {
        description: "Not a project member",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Run not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
