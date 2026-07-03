import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";


const BASELINE_PNG = fileURLToPath(
  new URL("../../src/fixtures/baseline.png", import.meta.url),
);

/** Screenshots are content-addressed: storage key = sha256(pngBytes) hex. */
function objectKey(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Capture a baseline, then fetch the stored PNG back through the authenticated
 * storage proxy (`GET /api/v1/storage/:key`) and assert the bytes round-trip.
 * Shared by the S3 and HDD backends — the only difference is which deployment
 * it runs against.
 */
async function assertScreenshotRoundTrip(
  request: APIRequestContext,
): Promise<void> {
  const api = new ApiClient(API);
  const { admin, pat } = ownerCreds();

  const project = await api.createProject(admin, {
    name: `e2e-storage-${Date.now()}`,
  });
  await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "baseline",
  });

  const bytes = readFileSync(BASELINE_PNG);
  const key = objectKey(bytes);
  const res = await request.get(`${API}/api/v1/storage/${key}`, {
    headers: { authorization: `Bearer ${admin}` },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image");
  const served = await res.body();
  expect(served.equals(bytes)).toBe(true);
}

test("S3: uploaded screenshot is served back through the proxy", async ({
  request,
}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["storage.s3_roundtrip"]));
  await assertScreenshotRoundTrip(request);
});

// DEFERRED (product bug the suite caught, task_67225ce5): HDD-mode Docker
// deploys can't WRITE screenshots — the furan_hdd_data volume is root-owned
// (drwxr-xr-x 0:0) but the apps run as the distroless nonroot user (uid 65532),
// so persistScreenshot's fs.writeFile throws EACCES → 500 (and reads 404). The
// compose hdd profile needs a chown init step. Un-skip once fixed to prove the
// HDD backend round-trips end to end.
test.skip("HDD: uploaded screenshot is served back through the proxy @hdd-smoke", async ({
  request,
}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["storage.hdd_roundtrip"]));
  await assertScreenshotRoundTrip(request);
});
