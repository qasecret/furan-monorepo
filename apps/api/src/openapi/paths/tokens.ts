import {
  createBody,
  paramsId,
  tokenCreateResponse,
  tokenListResponse,
} from "../../routes/tokens.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerTokensPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/account/tokens",
    summary: "List the caller's personal access tokens",
    tags: ["tokens"],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Caller's tokens (raw token bytes never returned)",
        content: { "application/json": { schema: tokenListResponse } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/account/tokens",
    summary: "Create a personal access token. Raw token is returned ONCE.",
    tags: ["tokens"],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: createBody } } },
    },
    responses: {
      201: {
        description:
          "Token created; capture `token` field now (never retrievable again)",
        content: { "application/json": { schema: tokenCreateResponse } },
      },
      400: {
        description: "Invalid body",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/account/tokens/{id}",
    summary: "Revoke a personal access token",
    tags: ["tokens"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsId },
    responses: {
      204: { description: "Token revoked" },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Token not found or not owned by caller",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
