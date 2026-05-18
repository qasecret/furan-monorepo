import { loginBody, loginResponse } from "../../routes/auth.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerAuthPaths(): void {
  registry.registerPath({
    method: "post",
    path: "/auth/login",
    summary: "Authenticate with email + password; returns a JWT",
    tags: ["auth"],
    request: {
      body: {
        content: { "application/json": { schema: loginBody } },
      },
    },
    responses: {
      200: {
        description: "Login successful",
        content: { "application/json": { schema: loginResponse } },
      },
      400: {
        description: "Invalid request body",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Invalid credentials or inactive user",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
