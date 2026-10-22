import { describe, expect, it } from "vitest";

import {
  SUITE_ORDER,
  USAGE,
  UsageError,
  parseCliArgs,
  runOrder,
} from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("runs every suite on the large shape by default", () => {
    const args = parseCliArgs([]);
    expect(args.suites).toEqual(["browser", "server", "pipeline"]);
    expect(args.shape).toBe("large");
    expect(args.storage).toBe("s3");
    expect(args.keep).toBe(false);
    expect(args.reuse).toBe(false);
    expect(args.noBuild).toBe(false);
  });

  it("reads an empty --suite as no suites", () => {
    expect(parseCliArgs(["--suite="]).suites).toEqual([]);
  });

  it("reads a --suite list in the fixed run order, without repeats", () => {
    expect(parseCliArgs(["--suite=pipeline,server,pipeline"]).suites).toEqual([
      "server",
      "pipeline",
    ]);
    expect(parseCliArgs(["--suite=pipeline,browser"]).suites).toEqual([
      "browser",
      "pipeline",
    ]);
  });

  it("rejects an unknown suite", () => {
    expect(() => parseCliArgs(["--suite=pipeline,nope"])).toThrow(UsageError);
  });

  it("rejects an unknown shape", () => {
    expect(() => parseCliArgs(["--shape=huge"])).toThrow(UsageError);
  });

  it("takes the smoke shape and hdd storage", () => {
    const args = parseCliArgs(["--shape=smoke", "--storage=hdd"]);
    expect(args.shape).toBe("smoke");
    expect(args.storage).toBe("hdd");
  });

  it("rejects an unknown storage", () => {
    expect(() => parseCliArgs(["--storage=gcs"])).toThrow(UsageError);
  });

  it("reads the boolean flags", () => {
    const args = parseCliArgs(["--keep", "--reuse", "--no-build"]);
    expect(args.keep).toBe(true);
    expect(args.reuse).toBe(true);
    expect(args.noBuild).toBe(true);
  });

  it("ignores the `--` a package manager puts before forwarded flags", () => {
    expect(parseCliArgs(["--", "--shape=smoke", "--suite="])).toMatchObject({
      shape: "smoke",
      suites: [],
    });
  });

  it("puts the report in scale/out, wherever it runs from, unless told", () => {
    expect(parseCliArgs([]).report).toMatch(/scale[\\/]out$/);
    expect(parseCliArgs(["--report=/tmp/elsewhere"]).report).toBe(
      "/tmp/elsewhere",
    );
  });

  it("rejects a flag it does not know", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(UsageError);
  });
});

describe("runOrder (Ruling R25)", () => {
  it("runs browser, then server, then pipeline", () => {
    expect(SUITE_ORDER).toEqual(["browser", "server", "pipeline"]);
  });

  it("orders any selection that way, whatever order it was given in", () => {
    expect(runOrder(["pipeline", "server", "browser"])).toEqual([
      "browser",
      "server",
      "pipeline",
    ]);
    expect(runOrder(["pipeline", "server"])).toEqual(["server", "pipeline"]);
    expect(runOrder(["server", "browser"])).toEqual(["browser", "server"]);
    expect(runOrder(["pipeline"])).toEqual(["pipeline"]);
    expect(runOrder([])).toEqual([]);
  });

  it("drops repeats", () => {
    expect(runOrder(["server", "server", "pipeline"])).toEqual([
      "server",
      "pipeline",
    ]);
  });

  it("says so in the help text, with the seed rule (R26)", () => {
    expect(USAGE).toMatch(/browser,server,pipeline/);
    expect(USAGE).toMatch(/always run in this order/);
    expect(USAGE).toMatch(/reseeds/);
  });
});
