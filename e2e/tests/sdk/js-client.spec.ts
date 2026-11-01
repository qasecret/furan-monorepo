import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { execa } from "execa";
import sharp from "sharp";

import { ApiClient } from "../../src/clients/api-client.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API, DASH_URL as DASH } from "../../src/env.js";
import { loadSeed, principal } from "../../src/seed/load-seed.js";
import type { SeededPrincipal } from "../../src/seed/seed.js";

/**
 * The JS on-ramp (ADR-080), driven as a user drives it: the built `furan`
 * CLI and a Playwright project using @furan/playwright, as subprocesses
 * against the stack under test, with an editor's token. The subprocesses get
 * a clean environment, so the runner's own CI variables never leak into the
 * client's CI detection.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(REPO, "packages/cli/dist/bin.js");
const PLAYWRIGHT_CLI = join(REPO, "e2e/node_modules/@playwright/test/cli.js");
const FIXTURE_CONFIG = join(REPO, "e2e/src/js-fixture/playwright.config.ts");
const FIXTURES = join(REPO, "e2e/src/fixtures");

const api = new ApiClient(API);
let admin = "";
let editor: SeededPrincipal;

test.beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(
      "packages/cli is not built: run `pnpm turbo run build --filter=@furan/cli --filter=@furan/playwright` first",
    );
  }
  const seed = loadSeed();
  admin = seed.bootstrapAdminJwt;
  editor = principal(seed, "editor");
});

/** A project of its own, with the editor as a member. */
async function newProject(name: string): Promise<string> {
  const project = await api.createProject(admin, {
    name: `e2e-js-${name}-${Date.now()}`,
  });
  await api.addMember(admin, project.id, editor.id);
  return project.id;
}

/** Only what a process needs to run, plus `extra`. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      ["PATH", "HOME", "TMPDIR", "USER", "LANG"].includes(key) ||
      key.startsWith("NODE_") ||
      key === "PLAYWRIGHT_BROWSERS_PATH"
    ) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

const furanEnv = (projectId: string, extra: Record<string, string> = {}) =>
  cleanEnv({
    FURAN_API_URL: API,
    FURAN_API_TOKEN: editor.pat,
    FURAN_PROJECT_ID: projectId,
    FURAN_BRANCH: "main",
    FURAN_DASHBOARD_URL: DASH,
    ...extra,
  });

async function runCli(args: string[], env: Record<string, string>) {
  const r = await execa("node", [CLI, ...args], {
    env,
    extendEnv: false,
    reject: false,
    timeout: 180_000,
  });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** A temp folder holding `files` (path → fixture name or PNG bytes). */
async function stage(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "furan-e2e-js-"));
  for (const [rel, src] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    if (typeof src === "string")
      await copyFile(join(FIXTURES, `${src}.png`), path);
    else await writeFile(path, src);
  }
  return dir;
}

async function buildCount(projectId: string): Promise<number> {
  const { body } = await api.request<{ items: unknown[] }>(
    "GET",
    `/projects/${projectId}/builds`,
    { auth: editor.pat },
  );
  return body.items.length;
}

test.describe.serial("sdk: JS CLI verdicts and exit codes", () => {
  let projectId = "";
  const upload = async (fixture: string | Buffer, ...flags: string[]) =>
    runCli(
      ["upload", await stage({ "home.png": fixture }), ...flags],
      furanEnv(projectId),
    );

  test.beforeAll(async () => {
    projectId = await newProject("cli");
  });

  test("first upload is new and passes with a warning", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["sdk.js.cli"]));
    const r = await upload("baseline");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("! new");
    expect(r.stdout).toContain("no baseline yet");
  });

  test("--fail-on-new exits 1", async () => {
    expect((await upload("baseline", "--fail-on-new")).code).toBe(1);
  });

  test("--save-new-tests approves the first baseline", async () => {
    const r = await upload("baseline", "--save-new-tests");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("✓ passed");
  });

  test("identical passes", async () => {
    const r = await upload("identical");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("✓ passed");
  });

  test("changed is unresolved and exits 1 with the review link", async () => {
    const r = await upload("changed");
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toContain("✗ unresolved");
    expect(r.stdout).toContain(`${DASH}/projects/${projectId}/runs/`);
  });

  test("a file that is not a PNG exits 2 and sends nothing", async () => {
    const before = await buildCount(projectId);
    const r = await upload(Buffer.from("not a png"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("home.png");
    expect(await buildCount(projectId)).toBe(before);
  });

  test("an unreachable api exits 3", async () => {
    const r = await runCli(
      ["upload", await stage({ "home.png": "baseline" })],
      furanEnv(projectId, { FURAN_API_URL: "http://127.0.0.1:9" }),
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("network_error");
  });
});

test.describe.serial("sdk: JS CLI folders and one batch per ciBuildId", () => {
  let projectId = "";
  let dir = "";

  test.beforeAll(async () => {
    projectId = await newProject("folders");
    dir = await stage({
      "cy/login.cy.ts/a.png": "baseline",
      "cy/cart.cy.ts/b.png": "baseline",
    });
    await writeFile(
      join(dir, "cy/cart.cy.ts/b.furan.json"),
      JSON.stringify({ ignore: [{ x: 0, y: 0, width: 10, height: 10 }] }),
    );
  });

  test("a Cypress-style folder maps to tests and namespaced steps", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["sdk.js.cli"]));
    const r = await runCli(
      ["upload", join(dir, "cy"), "--json", "--ci-build-id", "pipeline-1"],
      furanEnv(projectId),
    );
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      tests: Array<{ name: string; steps: string[]; status: string }>;
    };
    expect(out.tests.map((t) => [t.name, t.steps])).toEqual([
      ["cart.cy.ts", ["cart.cy.ts/b"]],
      ["login.cy.ts", ["login.cy.ts/a"]],
    ]);
    expect(out.tests.map((t) => t.status)).toEqual(["new", "new"]);
  });

  test("the same ciBuildId joins one batch; another makes a second", async () => {
    await runCli(
      ["upload", join(dir, "cy"), "--ci-build-id", "pipeline-1"],
      furanEnv(projectId),
    );
    expect(await buildCount(projectId)).toBe(1);
    await runCli(
      ["upload", join(dir, "cy"), "--ci-build-id", "pipeline-2"],
      furanEnv(projectId),
    );
    expect(await buildCount(projectId)).toBe(2);
  });
});

test.describe.serial("sdk: JS CLI ignore regions reach the baseline", () => {
  let projectId = "";
  const R = "40,40,120,120"; // covers the fixtures' square at 50,50 100×100

  test.beforeAll(async () => {
    projectId = await newProject("regions");
  });

  test("a region saved with the first baseline masks a later change inside it", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["sdk.js.regions"]));
    const env = furanEnv(projectId);
    const first = await runCli(
      [
        "upload",
        await stage({ "home.png": "baseline" }),
        "--ignore",
        R,
        "--save-new-tests",
      ],
      env,
    );
    expect(first.code, first.stderr).toBe(0);

    const inside = await runCli(
      ["upload", await stage({ "home.png": "changed" }), "--ignore", R],
      env,
    );
    expect(inside.code, inside.stdout).toBe(0);
    expect(inside.stdout).toContain("✓ passed");
  });

  test("a change outside the region is still found", async () => {
    const outside = await sharp(join(FIXTURES, "baseline.png"))
      .composite([
        {
          input: {
            create: {
              width: 60,
              height: 60,
              channels: 4,
              background: "#ff2020",
            },
          },
          left: 250,
          top: 150,
        },
      ])
      .png()
      .toBuffer();
    const r = await runCli(
      ["upload", await stage({ "home.png": outside }), "--ignore", R],
      furanEnv(projectId),
    );
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toContain("✗ unresolved");
  });
});

test.describe.serial("sdk: @furan/playwright fixture", () => {
  let projectId = "";
  const playwright = (extra: Record<string, string>) =>
    execa("node", [PLAYWRIGHT_CLI, "test", "-c", FIXTURE_CONFIG], {
      env: furanEnv(projectId, extra),
      extendEnv: false,
      reject: false,
      all: true,
      timeout: 180_000,
    });

  test.beforeAll(async () => {
    projectId = await newProject("playwright");
  });

  test("two workers share one batch and save their first baselines", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["sdk.js.playwright"]));
    const r = await playwright({ FURAN_SAVE_NEW_TESTS: "1" });
    expect(r.exitCode, r.all).toBe(0);
    expect(await buildCount(projectId)).toBe(1);
  });

  test("a changed page fails its test with the review link", async () => {
    const r = await playwright({ FIXTURE_COLOR: "#ff2020" });
    expect(r.exitCode, r.all).toBe(1);
    expect(r.all).toContain("needs review");
    expect(r.all).toContain(`${DASH}/projects/${projectId}/runs/`);
  });
});
