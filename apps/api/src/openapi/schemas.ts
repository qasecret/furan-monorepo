import { z } from "zod";

import { registry } from "./registry.js";

export const errorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({
    error: z
      .string()
      .describe(
        "Machine-readable error code (e.g. 'invalid_body', 'unauthenticated').",
      ),
  }),
);

export const uuidParam = z.string().uuid();
