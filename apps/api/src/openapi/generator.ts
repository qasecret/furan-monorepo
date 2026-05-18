import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registry } from "./registry.js";

let _registered = false;

function registerAll(): void {
  if (_registered) return;
  // Path registrars are added in subsequent tasks (5–9).
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
