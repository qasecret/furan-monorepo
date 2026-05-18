import { meResponse } from "../../routes/users.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerUsersPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/users/me",
    summary: "Current authenticated user",
    tags: ["users"],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "The caller's user record",
        content: { "application/json": { schema: meResponse } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
