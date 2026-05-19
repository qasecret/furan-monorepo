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
    summary: "List builds for a project (paginated, with optional filters)",
    tags: ["builds"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsId, query: querySchema },
    responses: {
      200: {
        description: "Builds ordered by createdAt desc with cursor",
        content: { "application/json": { schema: buildListResponse } },
      },
      400: {
        description: "Invalid query (e.g. malformed property filter)",
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
    summary:
      "Find-or-create a build under a project, keyed on (projectId, ciBuildId)",
    tags: ["builds"],
    security: [{ bearerAuth: [] }],
    request: {
      params: paramsId,
      body: {
        content: { "application/json": { schema: createBody } },
      },
    },
    responses: {
      200: {
        description: "Existing build reattached (request properties merged in)",
        content: { "application/json": { schema: buildResponse } },
      },
      201: {
        description: "New build created",
        content: { "application/json": { schema: buildResponse } },
      },
      400: {
        description: "Invalid body (validation failed)",
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
}
