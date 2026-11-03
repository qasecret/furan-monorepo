import { createHmac, generateKeyPairSync } from "node:crypto";

import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import type { FastifyInstance } from "fastify";
import { App } from "octokit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { Env } from "../src/env.js";
import { buildFastify } from "../src/fastify.js";

const SECRET = "test-webhook-secret"; // gitleaks:allow

describe("POST /webhooks/github", () => {
  let telemetry: Telemetry;
  let app: FastifyInstance;
  const received = vi.fn();

  beforeAll(async () => {
    telemetry = bootstrapTelemetry({
      service: "integrations-test",
      version: "test",
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const githubApp = new App({
      appId: 1,
      privateKey,
      webhooks: { secret: SECRET },
    });
    githubApp.webhooks.on("ping", ({ payload }) => received(payload));
    app = await buildFastify({ env: {} as Env, telemetry, githubApp });
  });

  afterAll(async () => {
    await app.close();
    await telemetry.shutdown();
  });

  const deliver = (body: string, secret = SECRET) =>
    app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "d1",
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      payload: body,
    });

  // A sender may escape characters that JSON.stringify writes raw, and the
  // signature covers the exact bytes: re-serializing the parsed body would
  // reject this genuine delivery.
  test("verifies the signature over the raw body, escapes and all", async () => {
    const body =
      '{"zen":"Keep it \\u003csimple\\u003e","hook":{"url":"https:\\/\\/x.test\\/h"}, "hook_id": 1}';
    const res = await deliver(body);
    expect(res.statusCode).toBe(204);
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ zen: "Keep it <simple>" }),
    );
  });

  test("rejects a body signed with another secret", async () => {
    const res = await deliver('{"zen":"x","hook_id":1}', "wrong-secret");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_signature" });
  });
});
