import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registerAuthPaths } from "./paths/auth.js";
import { registerBuildsPaths } from "./paths/builds.js";
import { registerHealthPaths } from "./paths/health.js";
import { registerMembersPaths } from "./paths/members.js";
import { registerProjectsPaths } from "./paths/projects.js";
import { registerTokensPaths } from "./paths/tokens.js";
import { registerUsersAdminPaths } from "./paths/users-admin.js";
import { registerUsersPaths } from "./paths/users.js";
import { registry } from "./registry.js";

let _registered = false;

function registerAll(): void {
  if (_registered) return;
  registerHealthPaths();
  registerUsersPaths();
  registerAuthPaths();
  registerTokensPaths();
  registerProjectsPaths();
  registerMembersPaths();
  registerBuildsPaths();
  registerUsersAdminPaths();
  _registered = true;
}

export function generateOpenApiDocument(): ReturnType<
  OpenApiGeneratorV31["generateDocument"]
> {
  registerAll();
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Furan API",
      version: "1.0.0",
      description:
        "Visual regression testing API. See https://github.com/qasecret/furan-monorepo for self-host docs.",
      license: {
        name: "Apache-2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
      },
    },
    servers: [{ url: "/" }],
  });
}
