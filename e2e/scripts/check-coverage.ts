import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Coverage gate for CI. Reads `e2e-coverage.json` (written by the coverage
 * reporter) and fails the run if any capability that actually executed
 * REGRESSED (state "failed"). "MISSING" capabilities (not yet implemented) and
 * "config-gated" ones (deliberately not run — cloud VLM, real Kotlin SDK) are
 * reported but do NOT fail the gate, so the known-incomplete matrix doesn't
 * block CI while it's being filled in. Playwright's own non-zero exit already
 * catches failures during the run; this adds an explicit, auditable summary.
 *
 *   pnpm --filter @furan/e2e exec tsx scripts/check-coverage.ts
 */
interface Row {
  area: string;
  id: string;
  label: string;
  state: "passed" | "failed" | "config-gated" | "MISSING";
}

const FILE = fileURLToPath(new URL("../e2e-coverage.json", import.meta.url));

function main(): void {
  let rows: Row[];
  try {
    rows = JSON.parse(readFileSync(FILE, "utf8")) as Row[];
  } catch {
    console.error(
      "[check-coverage] e2e-coverage.json not found — run the suite first",
    );
    process.exit(2);
  }

  const by = (s: Row["state"]): Row[] => rows.filter((r) => r.state === s);
  const failed = by("failed");
  const missing = by("MISSING");
  const passed = by("passed");
  const gated = by("config-gated");

  console.log(
    `[check-coverage] passed=${passed.length} failed=${failed.length} ` +
      `config-gated=${gated.length} missing=${missing.length} total=${rows.length}`,
  );
  if (missing.length > 0) {
    console.log(
      `  not-yet-implemented: ${missing.map((r) => r.id).join(", ")}`,
    );
  }
  if (failed.length > 0) {
    console.error(
      `  REGRESSED: ${failed.map((r) => r.id).join(", ")}`,
    );
    process.exit(1);
  }
  console.log("[check-coverage] OK — no regressed capabilities");
}

main();
