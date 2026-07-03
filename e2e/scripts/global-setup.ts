import { ApiClient } from "../src/clients/api-client.js";
import { loadSeed, principal } from "../src/seed/load-seed.js";
import { seedAll } from "../src/seed/seed.js";

import { API_URL } from "./compose.js";

/**
 * Playwright global setup: seed the deployment ONCE per run. To keep the
 * PAT-mint rate limit (#367) from tripping on a kept-alive stack, reuse an
 * existing `.seed.json` when its credentials still authenticate (same stack);
 * only re-seed (mint fresh PATs) when they don't — i.e. against a fresh DB.
 */
export default async function globalSetup(): Promise<void> {
  const api = new ApiClient(API_URL);

  try {
    const seed = loadSeed();
    const adminOk =
      (await api.probe("GET", "/users/me", { auth: seed.bootstrapAdminJwt }))
        .status === 200;
    const ownerOk =
      (await api.probe("GET", "/users/me", { auth: principal(seed, "owner").pat }))
        .status === 200;
    if (adminOk && ownerOk) {
       
      console.log("[global-setup] reusing existing .seed.json");
      return;
    }
  } catch {
    // no/invalid seed file → seed fresh below
  }

  await seedAll();
   
  console.log("[global-setup] seeded fresh principals + projects");
}
