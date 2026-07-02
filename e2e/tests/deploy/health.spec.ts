import { expect, test } from "@playwright/test";

import { coverAnnotations } from "../../src/coverage/reporter.js";

const API = process.env.E2E_API_URL ?? "http://localhost:3000";

test.describe("deploy: health", () => {
  test("GET /livez returns 200", async ({ request }, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["deploy.livez"]));
    const res = await request.get(`${API}/livez`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("GET /readyz is deeply ready (all checks ok)", async ({
    request,
  }, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["deploy.readyz"]));
    const res = await request.get(`${API}/readyz`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { checks: Record<string, string> };
    expect(Object.values(body.checks).length).toBeGreaterThan(0);
    for (const v of Object.values(body.checks)) expect(v).toBe("ok");
  });
});
