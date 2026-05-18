import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registerAuthPaths } from "./paths/auth.js";
import { registerHealthPaths } from "./paths/health.js";
import { registerTokensPaths } from "./paths/tokens.js";
import { registerUsersPaths } from "./paths/users.js";
import { registry } from "./registry.js";

let _registered = false;

function registerAll(): void {
  if (_registered) return;
  registerHealthPaths();
  registerUsersPaths();
  registerAuthPaths();
  registerTokensPaths();
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
