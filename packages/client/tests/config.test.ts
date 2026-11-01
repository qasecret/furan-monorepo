import { describe, expect, it, vi } from "vitest";

import {
  FuranConfigError,
  maskToken,
  parseProperties,
  resolveConfig,
} from "../src/index.js";

const PROJECT = "3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
const BUILD = "0e6b8f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const base = {
  FURAN_API_URL: "https://furan.example/api",
  FURAN_API_TOKEN: "furan_pat_SECRET123", // gitleaks:allow (fake test token)
  FURAN_PROJECT_ID: PROJECT,
};
const noGit = { gitBranch: () => null };

describe("resolveConfig", () => {
  it.each([["FURAN_API_URL"], ["FURAN_API_TOKEN"], ["FURAN_PROJECT_ID"]])(
    "requires %s",
    (variable) => {
      const env: Record<string, string> = { ...base };
      delete env[variable];
      try {
        resolveConfig({}, env, noGit);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FuranConfigError);
        expect((e as FuranConfigError).variable).toBe(variable);
      }
    },
  );

  it("projectId must be a UUID", () => {
    expect(() =>
      resolveConfig({}, { ...base, FURAN_PROJECT_ID: "my-project" }, noGit),
    ).toThrow(FuranConfigError);
  });

  it("apiUrl must be an http(s) URL", () => {
    expect(() =>
      resolveConfig({}, { ...base, FURAN_API_URL: "furan.example" }, noGit),
    ).toThrow(/FURAN_API_URL/);
  });

  it("FURAN_BUILD_ID must be a Furan build id, and says where a CI id goes", () => {
    expect(() =>
      resolveConfig({}, { ...base, FURAN_BUILD_ID: "abc123sha" }, noGit),
    ).toThrow(/FURAN_CI_BUILD_ID/);
    expect(
      resolveConfig({}, { ...base, FURAN_BUILD_ID: BUILD }, noGit).buildId,
    ).toBe(BUILD);
  });

  it("precedence: option > env > CI > git > main", () => {
    const ci = {
      GITHUB_ACTIONS: "true",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "ci-branch",
    };
    const git = { gitBranch: () => "git-branch" };
    expect(
      resolveConfig(
        { branch: "opt" },
        { ...base, ...ci, FURAN_BRANCH: "env" },
        git,
      ).branch,
    ).toBe("opt");
    expect(
      resolveConfig({}, { ...base, ...ci, FURAN_BRANCH: "env" }, git).branch,
    ).toBe("env");
    expect(resolveConfig({}, { ...base, ...ci }, git).branch).toBe("ci-branch");
    expect(resolveConfig({}, base, git).branch).toBe("git-branch");
    expect(resolveConfig({}, base, noGit).branch).toBe("main");
  });

  it("an undefined option counts as unset", () => {
    expect(
      resolveConfig(
        { branch: undefined },
        { ...base, FURAN_BRANCH: "env" },
        noGit,
      ).branch,
    ).toBe("env");
  });

  it("does not run git when the branch is known", () => {
    const gitBranch = vi.fn(() => "git-branch");
    resolveConfig({}, { ...base, FURAN_BRANCH: "env" }, { gitBranch });
    expect(gitBranch).not.toHaveBeenCalled();
  });

  it("takes ciBuildId, parent branch and build name and number from CI", () => {
    const c = resolveConfig(
      {},
      {
        ...base,
        GITHUB_ACTIONS: "true",
        GITHUB_HEAD_REF: "feature/x",
        GITHUB_BASE_REF: "main",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_NUMBER: "7",
      },
      noGit,
    );
    expect(c).toMatchObject({
      branch: "feature/x",
      parentBranch: "main",
      ciBuildId: "github-42-2",
      buildName: "CI #7",
      buildNumber: 7,
    });
    expect(
      resolveConfig({}, { ...base, FURAN_CI_BUILD_ID: "mine" }, noGit)
        .ciBuildId,
    ).toBe("mine");
  });

  it("trims a trailing slash from apiUrl and dashboardUrl", () => {
    const c = resolveConfig(
      {},
      {
        ...base,
        FURAN_API_URL: "https://furan.example/api/",
        FURAN_DASHBOARD_URL: "https://furan.example/",
      },
      noGit,
    );
    expect(c.apiUrl).toBe("https://furan.example/api");
    expect(c.dashboardUrl).toBe("https://furan.example");
  });

  it("seconds env become ms, with 120 s and 2 s defaults", () => {
    const d = resolveConfig({}, base, noGit);
    expect(d.timeoutMs).toBe(120_000);
    expect(d.pollIntervalMs).toBe(2_000);
    const c = resolveConfig(
      {},
      {
        ...base,
        FURAN_POLL_TIMEOUT_SECONDS: "30",
        FURAN_POLL_INTERVAL_SECONDS: "1",
      },
      noGit,
    );
    expect(c.timeoutMs).toBe(30_000);
    expect(c.pollIntervalMs).toBe(1_000);
    expect(() =>
      resolveConfig({}, { ...base, FURAN_POLL_TIMEOUT_SECONDS: "soon" }, noGit),
    ).toThrow(/FURAN_POLL_TIMEOUT_SECONDS/);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("FURAN_SAVE_NEW_TESTS=%j → %s", (value, expected) => {
    expect(
      resolveConfig({}, { ...base, FURAN_SAVE_NEW_TESTS: value }, noGit)
        .saveNewTests,
    ).toBe(expected);
  });

  it("reads failOnNew and the environment labels", () => {
    const c = resolveConfig(
      {},
      {
        ...base,
        FURAN_FAIL_ON_NEW: "1",
        FURAN_BROWSER: "chrome",
        FURAN_OS: "Linux",
        FURAN_DEVICE: "Pixel 8",
      },
      noGit,
    );
    expect(c).toMatchObject({
      failOnNew: true,
      browser: "chrome",
      os: "Linux",
      device: "Pixel 8",
    });
  });
});

describe("parseProperties", () => {
  it("drops malformed pairs with a warning", () => {
    const warn = vi.fn();
    expect(parseProperties("a=1;b=2,bad,=x", warn)).toEqual({ a: "1", b: "2" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("caps 20 keys", () => {
    const warn = vi.fn();
    const raw = Array.from({ length: 22 }, (_, i) => `k${i}=v`).join(",");
    expect(Object.keys(parseProperties(raw, warn))).toHaveLength(20);
    expect(warn).toHaveBeenCalled();
  });

  it("unset is empty", () => {
    expect(parseProperties(undefined)).toEqual({});
  });
});

describe("maskToken", () => {
  it("never returns the full token", () => {
    expect(maskToken("furan_pat_dummy1234")).toBe("furan_pat_****1234");
    expect(maskToken("short")).toBe("****");
    expect(maskToken("furan_pat_SECRET123")).not.toContain("SECRET");
  });
});
