import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "JWT (dashboard sessions) or `furan_pat_*` (SDK/CI). Both arrive on `Authorization: Bearer ...`. A token works only until it expires (`401 token_expired`), on its bound project or its owner's member projects (`403 token_project_mismatch` / `not_a_project_member`), and on the endpoints its scope allows: `sdk` the SDK/CI endpoints, `read` their GETs (`403 insufficient_scope`). Token management, admin endpoints and `/trpc` need a session (`403 session_required`).",
});
