import { describe, expect, it } from "vitest";

import { detectCi, type CiInfo } from "../src/index.js";

const none = {
  parentBranch: null,
  buildName: null,
  buildNumber: null,
} as const;

describe("detectCi", () => {
  it.each<[string, Record<string, string>, CiInfo]>([
    [
      "github push",
      {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_NUMBER: "7",
      },
      {
        provider: "github",
        branch: "main",
        parentBranch: null,
        ciBuildId: "github-42-1",
        buildName: "CI #7",
        buildNumber: 7,
      },
    ],
    [
      "gitlab branch pipeline",
      {
        GITLAB_CI: "true",
        CI_COMMIT_BRANCH: "main",
        CI_PIPELINE_ID: "900",
        CI_PIPELINE_IID: "12",
      },
      {
        provider: "gitlab",
        branch: "main",
        parentBranch: null,
        ciBuildId: "gitlab-900",
        buildName: "pipeline #12",
        buildNumber: 12,
      },
    ],
    [
      "gitlab merge request",
      {
        GITLAB_CI: "true",
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x",
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
        CI_PIPELINE_ID: "901",
      },
      {
        ...none,
        provider: "gitlab",
        branch: "feature/x",
        parentBranch: "main",
        ciBuildId: "gitlab-901",
      },
    ],
    [
      "circleci",
      {
        CIRCLECI: "true",
        CIRCLE_BRANCH: "main",
        CIRCLE_WORKFLOW_ID: "wf-1",
        CIRCLE_BUILD_NUM: "33",
      },
      {
        ...none,
        provider: "circleci",
        branch: "main",
        ciBuildId: "circleci-wf-1",
        buildNumber: 33,
      },
    ],
    [
      "jenkins change request",
      {
        JENKINS_URL: "https://ci.example/",
        CHANGE_BRANCH: "feature/x",
        CHANGE_TARGET: "main",
        BRANCH_NAME: "PR-5",
        BUILD_TAG: "jenkins-shop-PR-5-3",
        BUILD_NUMBER: "3",
      },
      {
        ...none,
        provider: "jenkins",
        branch: "feature/x",
        parentBranch: "main",
        ciBuildId: "jenkins-jenkins-shop-PR-5-3",
        buildNumber: 3,
      },
    ],
    [
      "buildkite pull request",
      {
        BUILDKITE: "true",
        BUILDKITE_BRANCH: "feature/x",
        BUILDKITE_PULL_REQUEST_BASE_BRANCH: "main",
        BUILDKITE_BUILD_ID: "b-1",
        BUILDKITE_BUILD_NUMBER: "9",
      },
      {
        ...none,
        provider: "buildkite",
        branch: "feature/x",
        parentBranch: "main",
        ciBuildId: "buildkite-b-1",
        buildNumber: 9,
      },
    ],
    [
      "azure pull request",
      {
        TF_BUILD: "True",
        BUILD_SOURCEBRANCH: "refs/pull/5/merge",
        SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature/x",
        SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
        BUILD_BUILDID: "77",
        BUILD_BUILDNUMBER: "20261101.3",
      },
      {
        provider: "azure",
        branch: "feature/x",
        parentBranch: "main",
        ciBuildId: "azure-77",
        buildName: "20261101.3",
        buildNumber: null,
      },
    ],
    [
      "bitbucket",
      {
        BITBUCKET_BUILD_NUMBER: "4",
        BITBUCKET_BRANCH: "main",
        BITBUCKET_PIPELINE_UUID: "{abc}",
      },
      {
        ...none,
        provider: "bitbucket",
        branch: "main",
        ciBuildId: "bitbucket-{abc}",
        buildNumber: 4,
      },
    ],
  ])("%s", (_name, env, expected) => {
    expect(detectCi(env)).toEqual(expected);
  });

  it("github pull_request uses head ref and base ref", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "5/merge",
      GITHUB_HEAD_REF: "feature/x",
      GITHUB_BASE_REF: "main",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(ci?.branch).toBe("feature/x");
    expect(ci?.parentBranch).toBe("main");
  });

  it("github tag push has no branch", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(ci?.branch).toBeNull();
  });

  it("github re-run attempt changes ciBuildId", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "42" };
    expect(detectCi({ ...env, GITHUB_RUN_ATTEMPT: "1" })?.ciBuildId).toBe(
      "github-42-1",
    );
    expect(detectCi({ ...env, GITHUB_RUN_ATTEMPT: "2" })?.ciBuildId).toBe(
      "github-42-2",
    );
  });

  it("jenkins strips origin/ from GIT_BRANCH", () => {
    const ci = detectCi({
      JENKINS_URL: "https://ci/",
      GIT_BRANCH: "origin/main",
    });
    expect(ci?.branch).toBe("main");
  });

  it("tag builds have no branch on every provider", () => {
    expect(
      detectCi({ GITLAB_CI: "true", CI_COMMIT_TAG: "v1" })?.branch,
    ).toBeNull();
    expect(
      detectCi({
        BUILDKITE: "true",
        BUILDKITE_BRANCH: "v1",
        BUILDKITE_TAG: "v1",
      })?.branch,
    ).toBeNull();
    expect(
      detectCi({
        JENKINS_URL: "https://ci/",
        BRANCH_NAME: "v1",
        TAG_NAME: "v1",
      })?.branch,
    ).toBeNull();
    expect(
      detectCi({ TF_BUILD: "True", BUILD_SOURCEBRANCH: "refs/tags/v1" })
        ?.branch,
    ).toBeNull();
  });

  it('buildkite base branch "false" is null', () => {
    const ci = detectCi({
      BUILDKITE: "true",
      BUILDKITE_BRANCH: "main",
      BUILDKITE_PULL_REQUEST_BASE_BRANCH: "false",
    });
    expect(ci?.parentBranch).toBeNull();
  });

  it("empty strings count as unset", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_HEAD_REF: "",
      GITHUB_BASE_REF: "",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
    });
    expect(ci).toMatchObject({
      branch: "main",
      parentBranch: null,
      ciBuildId: null,
    });
  });

  it("no CI env → null", () => {
    expect(detectCi({ PATH: "/usr/bin", HOME: "/home/u" })).toBeNull();
  });
});
