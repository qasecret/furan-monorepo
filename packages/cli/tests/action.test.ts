import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);
const PKG = fileURLToPath(new URL("..", import.meta.url));
const RUN = join(PKG, "action/run.sh");

/**
 * Run action/run.sh with a stub `npx` on PATH that prints its arguments, one
 * per line, and a GITHUB_ACTION_PATH whose package.json says 9.9.9.
 */
async function runAction(env: Record<string, string>, cwd?: string) {
  const dir = await mkdtemp(join(tmpdir(), "furan-action-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "npx"),
    '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nenv | grep "^FURAN_" | sort > "$FURAN_ENV_DUMP"\n',
  );
  await chmod(join(bin, "npx"), 0o755);
  const actionPath = join(dir, "action");
  await mkdir(actionPath);
  await writeFile(join(actionPath, "package.json"), '{"version":"9.9.9"}');
  const dump = join(dir, "env.txt");
  const { stdout } = await exec("bash", [RUN], {
    cwd: cwd ?? dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_ACTION_PATH: actionPath,
      FURAN_ENV_DUMP: dump,
      ...env,
    },
  });
  return {
    args: stdout.split("\n").slice(0, -1),
    furanEnv: await readFile(dump, "utf8").catch(() => ""),
  };
}

describe("action/run.sh", () => {
  it("runs the cli version from package.json", async () => {
    const { args } = await runAction({ INPUT_PATH: "shots" });
    expect(args).toEqual(["-y", "@furan/cli@9.9.9", "upload", "shots"]);
  });

  it("INPUT_VERSION overrides", async () => {
    const { args } = await runAction({
      INPUT_PATH: "shots",
      INPUT_VERSION: "0.2.0",
    });
    expect(args[1]).toBe("@furan/cli@0.2.0");
  });

  it("expands globs and keeps paths with spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "furan-glob-"));
    await mkdir(join(dir, "shots"));
    await writeFile(join(dir, "shots/a b.png"), "");
    await writeFile(join(dir, "shots/c.png"), "");
    const { args } = await runAction(
      { INPUT_PATH: "shots/*.png\n  other dir  \n" },
      dir,
    );
    // compgen lists matches in directory order; the CLI sorts them itself.
    expect(args.slice(3, 5).sort()).toEqual(["shots/a b.png", "shots/c.png"]);
    expect(args.slice(5)).toEqual(["other dir"]);
  });

  it("an unmatched line is passed through", async () => {
    const { args } = await runAction({ INPUT_PATH: "nothing/*.png" });
    expect(args.slice(3)).toEqual(["nothing/*.png"]);
  });

  it("maps inputs to flags", async () => {
    const { args } = await runAction({
      INPUT_PATH: "shots",
      INPUT_TEST: "smoke",
      INPUT_IGNORE: "0,0,10,10\n5,5,1,1",
      INPUT_MATCH_LEVEL: "Layout",
      INPUT_BROWSER: "chrome",
      INPUT_SAVE_NEW_TESTS: "true",
      INPUT_FAIL_ON_NEW: "true",
      INPUT_WAIT: "false",
      INPUT_TIMEOUT: "300",
      INPUT_ARGS: "--os\nLinux",
    });
    expect(args.slice(2)).toEqual([
      "upload",
      "shots",
      "--test",
      "smoke",
      "--ignore",
      "0,0,10,10",
      "--ignore",
      "5,5,1,1",
      "--match-level",
      "Layout",
      "--browser",
      "chrome",
      "--save-new-tests",
      "--fail-on-new",
      "--no-wait",
      "--timeout",
      "300",
      "--os",
      "Linux",
    ]);
  });

  it("false booleans and empty inputs add no flags", async () => {
    const { args } = await runAction({
      INPUT_PATH: "shots",
      INPUT_SAVE_NEW_TESTS: "false",
      INPUT_FAIL_ON_NEW: "false",
      INPUT_WAIT: "true",
      INPUT_TEST: "",
      INPUT_ARGS: "",
    });
    expect(args.slice(2)).toEqual(["upload", "shots"]);
  });

  it("exports connection inputs only when set, keeping the job's env", async () => {
    const { furanEnv } = await runAction({
      INPUT_PATH: "shots",
      INPUT_API_URL: "",
      FURAN_API_URL: "http://from-job-env/api",
      INPUT_TOKEN: "tok",
      INPUT_PROJECT_ID: "p1",
    });
    expect(furanEnv).toContain("FURAN_API_URL=http://from-job-env/api");
    expect(furanEnv).toContain("FURAN_API_TOKEN=tok");
    expect(furanEnv).toContain("FURAN_PROJECT_ID=p1");
  });

  it("a missing path input fails before running anything", async () => {
    await expect(runAction({ INPUT_PATH: "  \n" })).rejects.toThrow(
      /path input is required/,
    );
  });
});

describe("action.yml", () => {
  it("is valid YAML with the documented inputs and outputs", async () => {
    const doc = parseYaml(await readFile(join(PKG, "action.yml"), "utf8")) as {
      inputs: Record<string, { description: string; required?: boolean }>;
      outputs: Record<string, { value: string }>;
      runs: { using: string; steps: Array<{ id?: string }> };
    };
    expect(Object.keys(doc.inputs).sort()).toEqual(
      [
        "api-url",
        "args",
        "browser",
        "dashboard-url",
        "fail-on-new",
        "ignore",
        "match-level",
        "path",
        "project-id",
        "save-new-tests",
        "test",
        "timeout",
        "token",
        "version",
        "wait",
      ].sort(),
    );
    for (const input of Object.values(doc.inputs)) {
      expect(typeof input.description).toBe("string");
    }
    expect(doc.inputs.path!.required).toBe(true);
    expect(Object.keys(doc.outputs).sort()).toEqual([
      "build-id",
      "build-url",
      "status",
    ]);
    expect(doc.runs.using).toBe("composite");
    expect(doc.runs.steps.map((s) => s.id ?? null)).toEqual([
      "node-check",
      null,
      "upload",
    ]);
  });

  it("action.yml never interpolates inputs in run:", async () => {
    const text = await readFile(join(PKG, "action.yml"), "utf8");
    let runIndent: number | null = null;
    const offenders: string[] = [];
    for (const line of text.split("\n")) {
      const indent = line.length - line.trimStart().length;
      if (runIndent !== null && line.trim() !== "" && indent <= runIndent) {
        runIndent = null;
      }
      const run = /^(\s*)(-\s+)?run:/.exec(line);
      if (run) {
        runIndent = run[1]!.length + (run[2]?.length ?? 0);
        if (line.includes("${{")) offenders.push(line);
        continue;
      }
      if (runIndent !== null && line.includes("${{")) offenders.push(line);
    }
    expect(offenders).toEqual([]);
    expect(text).toContain('run: bash "$GITHUB_ACTION_PATH/action/run.sh"');
  });

  it("declares every input run.sh reads", async () => {
    const yml = await readFile(join(PKG, "action.yml"), "utf8");
    const sh = await readFile(RUN, "utf8");
    const read = [...sh.matchAll(/INPUT_([A-Z_]+)/g)].map((m) =>
      m[1]!.toLowerCase().replace(/_/g, "-"),
    );
    for (const input of new Set(read)) {
      expect(yml).toMatch(new RegExp(`^  ${input}:`, "m"));
    }
  });
});
