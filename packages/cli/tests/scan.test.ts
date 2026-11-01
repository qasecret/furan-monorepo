import { promises as fsp } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { FuranInputError } from "@furan/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planUpload } from "../src/scan.js";

import { TINY_PNG, tree } from "./helpers.js";

const shape = (plan: Awaited<ReturnType<typeof planUpload>>) =>
  plan.map((t) => ({ test: t.name, steps: t.steps.map((s) => s.name) }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planUpload", () => {
  it("folder becomes the test and the step keeps its folder", async () => {
    const root = await tree({
      "login.cy.ts/empty-form.png": null,
      "login.cy.ts/error-state.png": null,
      "cart.cy.ts/two-items.png": null,
    });
    expect(shape(await planUpload([root], { test: null }))).toEqual([
      { test: "cart.cy.ts", steps: ["cart.cy.ts/two-items"] },
      {
        test: "login.cy.ts",
        steps: ["login.cy.ts/empty-form", "login.cy.ts/error-state"],
      },
    ]);
  });

  it("nested folders join with /", async () => {
    const root = await tree({ "a/b/c.png": null });
    expect(shape(await planUpload([root], { test: null }))).toEqual([
      { test: "a/b", steps: ["a/b/c"] },
    ]);
  });

  it("top-level files go to a test named after the root", async () => {
    const root = await tree({ "shots/home.png": null });
    const shots = join(root, "shots");
    expect(shape(await planUpload([shots], { test: null }))).toEqual([
      { test: "shots", steps: ["home"] },
    ]);
  });

  it("file arguments use their own folder as root", async () => {
    const root = await tree({
      "shots/home.png": null,
      "shots/pricing.png": null,
    });
    const plan = await planUpload(
      [join(root, "shots/pricing.png"), join(root, "shots/home.png")],
      { test: null },
    );
    expect(shape(plan)).toEqual([
      { test: "shots", steps: ["home", "pricing"] },
    ]);
    expect(plan[0]!.steps[0]).toMatchObject({
      file: join(root, "shots/home.png"),
      width: 1,
      height: 1,
      sidecar: null,
    });
  });

  it("--test puts everything in one test, step names unchanged", async () => {
    const root = await tree({
      "a/x.png": null,
      "b/y.png": null,
      "z.png": null,
    });
    expect(shape(await planUpload([root], { test: "smoke" }))).toEqual([
      { test: "smoke", steps: ["a/x", "b/y", "z"] },
    ]);
  });

  it("duplicate step names in one test are an input error", async () => {
    const root = await tree({ "a/home.png": null, "b/home.png": null });
    await expect(
      planUpload([join(root, "a/home.png"), join(root, "b/home.png")], {
        test: "smoke",
      }),
    ).rejects.toThrow(/step "home"/);
  });

  it("non-PNG file argument is an input error", async () => {
    const root = await tree({ "notes.txt": "hi" });
    await expect(
      planUpload([join(root, "notes.txt")], { test: null }),
    ).rejects.toBeInstanceOf(FuranInputError);
  });

  it("a missing path is an input error", async () => {
    await expect(
      planUpload(["/no/such/folder/anywhere"], { test: null }),
    ).rejects.toThrow(/no such file or folder/);
  });

  it("no PNGs found is an input error", async () => {
    const root = await tree({ "notes.txt": "hi" });
    await expect(planUpload([root], { test: null })).rejects.toThrow(
      /no \.png files/,
    );
  });

  it("zero-byte and truncated PNG are input errors", async () => {
    const root = await tree({
      "empty.png": new Uint8Array(0),
      "short.png": TINY_PNG.slice(0, 20),
    });
    await expect(
      planUpload([join(root, "empty.png")], { test: null }),
    ).rejects.toThrow(/empty\.png/);
    await expect(
      planUpload([join(root, "short.png")], { test: null }),
    ).rejects.toThrow(/short\.png/);
  });

  it("planUpload reads headers only", async () => {
    const root = await tree({
      "a.png": null,
      "b.png": null,
      "b.furan.json": JSON.stringify({ ignore: [] }),
    });
    const readFile = vi.spyOn(fsp, "readFile");
    await planUpload([root], { test: null });
    const read = readFile.mock.calls.map((c) => basename(String(c[0])));
    // The spy sees the sidecar read (so it is wired), and never a PNG.
    expect(read).toContain("b.furan.json");
    expect(read.filter((f) => f.endsWith(".png"))).toEqual([]);
  });

  it("symlinked directories are not followed", async () => {
    const root = await tree({ "real/a.png": null });
    const other = await tree({ "b.png": null });
    await mkdir(join(root, "links"));
    await symlink(other, join(root, "links/elsewhere"), "dir");
    expect(shape(await planUpload([root], { test: null }))).toEqual([
      { test: "real", steps: ["real/a"] },
    ]);
  });

  it("sidecar is attached to its step", async () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };
    const root = await tree({
      "home.png": null,
      "home.furan.json": JSON.stringify({
        matchLevel: "Layout",
        ignore: [box],
      }),
    });
    const plan = await planUpload([root], { test: null });
    expect(plan[0]!.steps[0]!.sidecar).toEqual({
      matchLevel: "Layout",
      ignore: [box],
    });
  });
});
