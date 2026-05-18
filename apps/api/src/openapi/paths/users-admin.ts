import {
  createBody,
  listQuery,
  paramsId,
  updateBody,
  userListResponse,
  userResponse,
} from "../../routes/users-admin.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerUsersAdminPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/users",
    summary: "List users (admin only)",
    tags: ["users-admin"],
    security: [{ bearerAuth: [] }],
    request: { query: listQuery },
    responses: {
      200: {
        description: "Paginated user list",
        content: { "application/json": { schema: userListResponse } },
      },
      400: {
        description: "Invalid query",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      403: {
        description: "Not admin",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/users",
    summary: "Create a user (admin only)",
    tags: ["users-admin"],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: createBody } } },
    },
    responses: {
      201: {
        description: "User created",
        content: { "application/json": { schema: userResponse } },
      },
      400: {
        description: "Invalid body",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      403: {
        description: "Not admin",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      409: {
        description: "Email already taken",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/users/{id}",
    summary: "Update a user (admin only). Cannot disable self.",
    tags: ["users-admin"],
    security: [{ bearerAuth: [] }],
    request: {
      params: paramsId,
      body: { content: { "application/json": { schema: updateBody } } },
    },
    responses: {
      200: {
        description: "Updated user record",
        content: { "application/json": { schema: userResponse } },
      },
      400: {
        description: "Invalid body or attempted self-disable",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      403: {
        description: "Not admin",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
