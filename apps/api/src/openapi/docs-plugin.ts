import fastifyApiReference from "@scalar/fastify-api-reference";
import type { FastifyPluginAsync } from "fastify";
import fastifyPlugin from "fastify-plugin";

import { generateOpenApiDocument } from "./generator.js";

const docsPlugin: FastifyPluginAsync = async (app) => {
  // Compute once at boot — the spec is deterministic given the code on disk.
  const document = generateOpenApiDocument();

  app.get("/openapi.json", async () => document);

  await app.register(fastifyApiReference, {
    routePrefix: "/docs",
    // Scalar 1.57+ uses configuration.content directly (not configuration.spec.content).
    configuration: {
      content: document,
      theme: "default",
    },
  });
};

export default fastifyPlugin(docsPlugin, { name: "furan-docs" });
