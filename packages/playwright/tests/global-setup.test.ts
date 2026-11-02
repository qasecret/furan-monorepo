import { afterEach, describe, expect, it } from "vitest";

import globalSetup from "../src/global-setup.js";

const KEYS = [
  "FURAN_CI_BUILD_ID",
  "FURAN_BUILD_ID",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const clear = () => {
  for (const k of KEYS) delete process.env[k];
};

describe("globalSetup", () => {
  it("sets a local id when none exists", () => {
    clear();
    globalSetup();
    expect(process.env.FURAN_CI_BUILD_ID).toMatch(/^local-[0-9a-f-]{36}$/);
  });

  it("keeps an existing FURAN_CI_BUILD_ID", () => {
    clear();
    process.env.FURAN_CI_BUILD_ID = "mine";
    globalSetup();
    expect(process.env.FURAN_CI_BUILD_ID).toBe("mine");
  });

  it("does nothing when attaching to an existing build", () => {
    clear();
    process.env.FURAN_BUILD_ID = "0e6b8f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
    globalSetup();
    expect(process.env.FURAN_CI_BUILD_ID).toBeUndefined();
  });

  it("does nothing under GitHub Actions", () => {
    clear();
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "1";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    globalSetup();
    expect(process.env.FURAN_CI_BUILD_ID).toBeUndefined();
  });
});
