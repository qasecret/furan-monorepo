import {
  addBody,
  memberResponse,
  paramsAdd,
  paramsRemove,
} from "../../routes/members.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerMembersPaths(): void {
  registry.registerPath({
    method: "post",
    path: "/projects/{id}/members",
    summary: "Add a member to a project (admin only)",
    tags: ["members"],
    security: [{ bearerAuth: [] }],
    request: {
      params: paramsAdd,
      body: { content: { "application/json": { schema: addBody } } },
    },
    responses: {
      201: {
        description: "Member added",
        content: { "application/json": { schema: memberResponse } },
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
      404: {
        description: "Project not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      409: {
        description: "User is already a member of the project",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/projects/{id}/members/{userId}",
    summary: "Remove a member from a project (admin only)",
    tags: ["members"],
    security: [{ bearerAuth: [] }],
    request: { params: paramsRemove },
    responses: {
      204: { description: "Member removed" },
      401: {
        description: "Unauthenticated",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      403: {
        description: "Not admin",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "Membership not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });
}
