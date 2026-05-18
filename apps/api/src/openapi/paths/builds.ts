import {
  buildListResponse,
  buildResponse,
  createBody,
  paramsId,
  querySchema,
} from "../../routes/builds.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerBuildsPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/projects/{id}/builds",
    summary: "List builds for a project (most recent first)",
    tags: ["builds"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsId, query: querySchema },
    responses: {
      200: {
        description: "Builds ordered by createdAt desc",
        content: { "application/json": { schema: buildListResponse } },
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
        description: "Not a project member",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Project not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/projects/{id}/builds",
    summary: "Create a build under a project",
    tags: ["builds"],
    security: [{ bearerAuth: [] }],
    request: {
      params: paramsId,
      body: { content: { "application/json": { schema: createBody } } },
    },
    responses: {
      201: {
        description: "Build created",
        content: { "application/json": { schema: buildResponse } },
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
        description: "Not a project member with write access",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Project not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
