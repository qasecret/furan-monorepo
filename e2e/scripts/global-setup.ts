import { ApiClient } from "../src/clients/api-client.js";
import { loadSeed } from "../src/seed/load-seed.js";
import { seedAll } from "../src/seed/seed.js";

import { API_URL } from "./compose.js";

const EXPECTED_PRINCIPALS = 4; // owner + admin + editor + guest

/**
 * Playwright global setup: seed the deployment ONCE per run. To keep the
 * PAT-mint rate limit (#367) from tripping on a kept-alive stack, reuse an
 * existing `.seed.json` when it is COMPLETE and every credential still
 * authenticates (same stack); only re-seed (mint fresh PATs) when it isn't —
 * i.e. against a fresh DB, a partial/corrupt seed, or rotated tokens.
 *
 * Reuse is validated fully (admin JWT + all four principal PATs + a project),
 * not just a sample: a partially-valid seed would otherwise be accepted whole
 * and surface later as a confusing "401 in an RBAC test" rather than a re-seed.
 */
export default async function globalSetup(): Promise<void> {
  const api = new ApiClient(API_URL);

  try {
    const seed = loadSeed();
    const complete =
      seed.principals.length === EXPECTED_PRINCIPALS && seed.projects.length > 0;
    const authChecks = [
      api.probe("GET", "/users/me", { auth: seed.bootstrapAdminJwt }),
      ...seed.principals.map((p) =>
        api.probe("GET", "/users/me", { auth: p.pat }),
      ),
    ];
    const allAuth = (await Promise.all(authChecks)).every(
      (r) => r.status === 200,
    );
    if (complete && allAuth) {
      console.log("[global-setup] reusing existing .seed.json");
      return;
    }
  } catch {
    // no/invalid seed file → seed fresh below
  }

  await seedAll();
  console.log("[global-setup] seeded fresh principals + projects");
}
