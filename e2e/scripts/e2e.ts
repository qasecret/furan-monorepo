import { execa } from "execa";

import { seedAll } from "../src/seed/seed.js";

import {
  API_URL,
  DASH_URL,
  down,
  logs,
  up,
  ROOT,
  type StorageMode,
} from "./compose.js";
import { waitHealthy } from "./wait-health.js";

// Point the test client + Playwright at the isolated e2e host ports (3010/3011)
// before any of them read the env. Downstream (wait-health, tests,
// playwright.config) all default to these envs.
process.env.E2E_API_URL = API_URL;
process.env.E2E_DASH_URL = DASH_URL;

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const val = (flag: string, def: string): string =>
  args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1] ?? def;

const mode = val("--storage", "s3") as StorageMode;
const project = val("--project", "s3-full");

async function main(): Promise<void> {
  if (has("--down-only")) {
    await down(mode);
    return;
  }

  await up(mode);
  try {
    await waitHealthy();
    await seedAll();
    if (has("--up-only")) {
      console.log(`stack up (${mode}) + seeded — leaving running`);
      return;
    }
    await execa("pnpm", ["exec", "playwright", "test", `--project=${project}`], {
      cwd: `${ROOT}e2e`,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("e2e run failed — dumping compose logs");
    await logs(mode).catch(() => undefined);
    throw err;
  } finally {
    if (!has("--keep") && !has("--up-only")) {
      await down(mode);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
