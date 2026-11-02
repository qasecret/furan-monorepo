import { describe, expect, it } from "vitest";

import { parseArgs, parseBox, UsageError } from "../src/args.js";

const upload = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "upload") throw new Error(`got ${parsed.kind}`);
  return parsed.args;
};

describe("parseArgs", () => {
  it("defaults: wait true, timeout unset (config default 120), concurrency 4", () => {
    expect(upload(["upload", "shots"])).toEqual({
      paths: ["shots"],
      test: null,
      ignore: [],
      matchLevel: null,
      browser: null,
      os: null,
      device: null,
      viewport: null,
      branch: null,
      parentBranch: null,
      buildName: null,
      ciBuildId: null,
      saveNewTests: false,
      failOnNew: false,
      wait: true,
      timeoutSeconds: null,
      concurrency: 4,
      json: false,
      dryRun: false,
    });
  });

  it("parses upload with every flag", () => {
    expect(
      upload([
        "upload",
        "a.png",
        "shots",
        "--test",
        "smoke",
        "--ignore",
        "1,2,3,4",
        "--match-level",
        "Layout",
        "--browser",
        "chrome",
        "--os",
        "Linux",
        "--device",
        "Pixel 8",
        "--viewport",
        "1280x720",
        "--branch",
        "feature/x",
        "--parent-branch",
        "main",
        "--build-name",
        "nightly",
        "--ci-build-id",
        "ci-1",
        "--save-new-tests",
        "--fail-on-new",
        "--timeout",
        "30",
        "--concurrency",
        "8",
        "--json",
        "--dry-run",
      ]),
    ).toEqual({
      paths: ["a.png", "shots"],
      test: "smoke",
      ignore: [{ x: 1, y: 2, width: 3, height: 4 }],
      matchLevel: "Layout",
      browser: "chrome",
      os: "Linux",
      device: "Pixel 8",
      viewport: "1280x720",
      branch: "feature/x",
      parentBranch: "main",
      buildName: "nightly",
      ciBuildId: "ci-1",
      saveNewTests: true,
      failOnNew: true,
      wait: true,
      timeoutSeconds: 30,
      concurrency: 8,
      json: true,
      dryRun: true,
    });
  });

  it("--ignore repeats", () => {
    expect(
      upload(["upload", "s", "--ignore", "0,0,1,1", "--ignore", "5,5,2,2"])
        .ignore,
    ).toEqual([
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 5, y: 5, width: 2, height: 2 },
    ]);
  });

  it("--no-wait sets wait false", () => {
    expect(upload(["upload", "s", "--no-wait"]).wait).toBe(false);
  });

  it("clamps --concurrency to 1..16", () => {
    expect(upload(["upload", "s", "--concurrency", "99"]).concurrency).toBe(16);
    expect(upload(["upload", "s", "--concurrency", "0"]).concurrency).toBe(1);
  });

  it.each([
    [["upload", "s", "--frobnicate"]],
    [["upload", "s", "--match-level", "Fuzzy"]],
    [["upload", "s", "--timeout", "0"]],
    [["upload", "s", "--timeout", "soon"]],
    [["upload", "s", "--concurrency", "two"]],
    [["upload", "s", "--viewport", "wide"]],
    [["upload"]],
    [["download", "s"]],
  ])("rejects %j with UsageError", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it("--help / -h → help; --version / -v → version; nothing → help", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-h"]).kind).toBe("help");
    expect(parseArgs(["upload", "--help"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
    expect(parseArgs(["-v"]).kind).toBe("version");
    expect(parseArgs([]).kind).toBe("help");
  });
});

describe("parseBox", () => {
  it("parses x,y,width,height", () => {
    expect(parseBox(" 10, 20.5 ,30,40")).toEqual({
      x: 10,
      y: 20.5,
      width: 30,
      height: 40,
    });
  });

  it.each(["1,2,3", "1,2,-3,4", "1,2,0,4", "a,b,c,d", "1,2,3,4,5", "-1,0,1,1"])(
    "rejects %j",
    (text) => {
      expect(() => parseBox(text)).toThrow(UsageError);
    },
  );
});
