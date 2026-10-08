import { expect, test } from "@playwright/test";

import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";


test.describe("deploy: api surface", () => {
  test("GET /openapi.json exposes the root REST routes", async ({
    request,
  }, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["deploy.openapi"]));
    const res = await request.get(`${API}/openapi.json`);
    expect(res.status()).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    // REST routes live at the ROOT (not /api/v1) — pin a representative set.
    for (const p of ["/auth/login", "/runs", "/projects", "/account/tokens"]) {
      expect(spec.paths).toHaveProperty(p);
    }
  });

  test("GET /metrics exposes the auth-failure counter after a failure", async ({
    request,
  }, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["deploy.metrics"]));
    // furan_auth_failures_total is a labelled counter registered lazily (WeakMap)
    // — it only appears once a failure is recorded. Trigger one bad login, which
    // both exercises the #361 hardening and materializes the series.
    const bad = await request.post(`${API}/auth/login`, {
      data: { email: "nobody@furan.test", password: "definitely-wrong" },
    });
    expect(bad.status()).toBe(401);

    const res = await request.get(`${API}/metrics`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("furan_auth_failures_total");
    expect(body).toContain('reason="invalid_credentials"');
  });
});
