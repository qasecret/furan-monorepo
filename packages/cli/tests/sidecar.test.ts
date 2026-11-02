import { join } from "node:path";

import { FuranInputError } from "@furan/client";
import { describe, expect, it } from "vitest";

import { parseSidecar, readSidecar } from "../src/sidecar.js";

import { tree } from "./helpers.js";

const box = { x: 1, y: 2, width: 3, height: 4 };

describe("parseSidecar", () => {
  it("accepts matchLevel and the four box kinds", () => {
    expect(
      parseSidecar(
        {
          matchLevel: "Layout",
          ignore: [box],
          layout: [box],
          content: [],
          floating: [{ ...box, maxUpOffset: 5 }],
        },
        "a.furan.json",
      ),
    ).toEqual({
      matchLevel: "Layout",
      ignore: [box],
      layout: [box],
      content: [],
      floating: [{ ...box, maxUpOffset: 5 }],
    });
  });

  it.each([
    ["unknown keys", { ignore: [box], mask: [] }],
    ["a box with a string coordinate", { ignore: [{ ...box, x: "1" }] }],
    ["a box with an unknown key", { ignore: [{ ...box, selector: ".a" }] }],
    ["a bad match level", { matchLevel: "Fuzzy" }],
    ["51 boxes", { ignore: Array.from({ length: 51 }, () => box) }],
    ["a non-object", [box]],
  ])("rejects %s", (_name, json) => {
    expect(() => parseSidecar(json, "a.furan.json")).toThrow(FuranInputError);
    expect(() => parseSidecar(json, "a.furan.json")).toThrow(/a\.furan\.json/);
  });
});

describe("readSidecar", () => {
  it("reads <stem>.furan.json beside the PNG", async () => {
    const root = await tree({
      "home.png": null,
      "home.furan.json": JSON.stringify({ ignore: [box] }),
    });
    expect(await readSidecar(join(root, "home.png"))).toEqual({
      ignore: [box],
    });
  });

  it("missing sidecar → null", async () => {
    const root = await tree({ "home.png": null });
    expect(await readSidecar(join(root, "home.png"))).toBeNull();
  });

  it("invalid JSON names the file", async () => {
    const root = await tree({ "home.png": null, "home.furan.json": "{" });
    await expect(readSidecar(join(root, "home.png"))).rejects.toThrow(
      /home\.furan\.json.*JSON/,
    );
  });
});
