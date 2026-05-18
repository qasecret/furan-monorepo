import {
  livezResponse,
  metricsResponse,
  readyzResponse,
} from "../../routes/health.js";
import { registry } from "../registry.js";

export function registerHealthPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/livez",
    summary: "Liveness probe",
    tags: ["health"],
    responses: {
      200: {
        description: "Process is alive",
        content: { "application/json": { schema: livezResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/readyz",
    summary: "Readiness probe — checks Postgres, Redis, object storage",
    tags: ["health"],
    responses: {
      200: {
        description: "All dependencies reachable",
        content: { "application/json": { schema: readyzResponse } },
      },
      503: {
        description: "At least one dependency is unreachable",
        content: { "application/json": { schema: readyzResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/metrics",
    summary: "Prometheus metrics exposition",
    tags: ["health"],
    responses: {
      200: {
        description: "Metrics in Prometheus exposition format",
        content: { "text/plain": { schema: metricsResponse } },
      },
    },
  });
}
