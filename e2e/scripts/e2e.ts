import { execa } from "execa";

import { seedAll } from "../src/seed/seed.js";

import { down, logs, up, ROOT, type StorageMode } from "./compose.js";
import { waitHealthy } from "./wait-health.js";

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
