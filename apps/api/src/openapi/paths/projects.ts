import {
  createBody,
  paramsId,
  projectListResponse,
  projectResponse,
} from "../../routes/projects.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerProjectsPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/projects",
    summary: "List projects visible to the caller",
    tags: ["projects"],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description:
          "Projects the caller has access to (admin: all; editor: member-of; guest: empty)",
        content: { "application/json": { schema: projectListResponse } },
      },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/projects",
    summary: "Create a project (admin only)",
    tags: ["projects"],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: createBody } } },
    },
    responses: {
      201: {
        description: "Project created",
        content: { "application/json": { schema: projectResponse } },
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
        description: "Project name taken",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/projects/{id}",
    summary: "Fetch a project by id (project members only)",
    tags: ["projects"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsId },
    responses: {
      200: {
        description: "Project record",
        content: { "application/json": { schema: projectResponse } },
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
        description: "Project not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
