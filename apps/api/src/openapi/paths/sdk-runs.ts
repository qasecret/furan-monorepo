import {
  createRunBody,
  createRunResponse,
  screenshotsParams,
  telemetryBody,
  uploadScreenshotForm,
  uploadScreenshotResponse,
} from "../../routes/sdk-runs.js";
import { registry } from "../registry.js";
import { errorResponseSchema } from "../schemas.js";

export function registerSdkRunsPaths(): void {
  registry.registerPath({
    method: "post",
    path: "/runs",
    summary: "Create a test run (SDK)",
    tags: ["sdk"],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: createRunBody } } },
    },
    responses: {
      200: {
        description: "Run created (or upserted via test variation lookup)",
        content: { "application/json": { schema: createRunResponse } },
      },
      400: {
        description: "Invalid body or build does not belong to the project",
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
    },
  });

  registry.registerPath({
    method: "post",
    path: "/runs/{runId}/screenshots",
    summary:
      "Upload a screenshot for a run. Multipart form with PNG bytes + optional DOM HTML. 50 MB max per file part.",
    tags: ["sdk"],
    security: [{ bearerAuth: [] }],
    request: {
      params: screenshotsParams,
      body: {
        content: {
          "multipart/form-data": { schema: uploadScreenshotForm },
        },
      },
    },
    responses: {
      200: {
        description: "Screenshot accepted; returns the stored record",
        content: { "application/json": { schema: uploadScreenshotResponse } },
      },
      400: {
        description:
          "Multipart parse failure, missing pngBytes, or other client error",
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
        description: "Run not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      413: {
        description: "File part exceeded the 50 MB limit",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/_telemetry/sdk",
    summary:
      "Anonymous SDK telemetry sink. Body is logged and discarded. Always returns 204.",
    tags: ["sdk"],
    request: {
      body: { content: { "application/json": { schema: telemetryBody } } },
    },
    responses: {
      204: { description: "Telemetry accepted" },
    },
  });
}
