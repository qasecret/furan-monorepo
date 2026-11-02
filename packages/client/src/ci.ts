import { execFileSync } from "node:child_process";

export type CiProvider =
  | "github"
  | "gitlab"
  | "circleci"
  | "jenkins"
  | "buildkite"
  | "azure"
  | "bitbucket";

/** What a CI system tells us about the pipeline this process runs in. */
export interface CiInfo {
  provider: CiProvider;
  /** The branch under test; null on a tag build or when the CI doesn't say. */
  branch: string | null;
  /** The pull/merge request's target branch (ADR-055's parent tier). */
  parentBranch: string | null;
  /** One id per pipeline (and per re-run attempt), so all its jobs share a batch. */
  ciBuildId: string | null;
  buildName: string | null;
  buildNumber: number | null;
}

type Env = NodeJS.ProcessEnv;

/** An env value, or null when unset or blank. */
const v = (env: Env, key: string): string | null => {
  const value = env[key]?.trim();
  return value ? value : null;
};

const int = (value: string | null): number | null =>
  value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;

const prefixed = (prefix: string, id: string | null): string | null =>
  id === null ? null : `${prefix}-${id}`;

/** `refs/heads/x` → `x`; any other `refs/…` (a tag, a PR merge ref) → null. */
const headRef = (ref: string | null): string | null => {
  if (ref === null) return null;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref.startsWith("refs/") ? null : ref;
};

interface Row {
  provider: CiProvider;
  detect: (env: Env) => boolean;
  read: (env: Env) => Omit<CiInfo, "provider">;
}

// One row per CI system (spec §4.3). Order matters only if a runner sets
// several systems' markers, which none do.
const ROWS: Row[] = [
  {
    provider: "github",
    detect: (env) => v(env, "GITHUB_ACTIONS") === "true",
    read: (env) => {
      const refType = v(env, "GITHUB_REF_TYPE");
      const pushBranch =
        refType === "branch"
          ? v(env, "GITHUB_REF_NAME")
          : refType === null
            ? headRef(v(env, "GITHUB_REF"))
            : null;
      const runId = v(env, "GITHUB_RUN_ID");
      const workflow = v(env, "GITHUB_WORKFLOW");
      const runNumber = v(env, "GITHUB_RUN_NUMBER");
      return {
        branch: v(env, "GITHUB_HEAD_REF") ?? pushBranch,
        parentBranch: v(env, "GITHUB_BASE_REF"),
        ciBuildId:
          runId === null
            ? null
            : `github-${runId}-${v(env, "GITHUB_RUN_ATTEMPT") ?? "1"}`,
        buildName:
          workflow !== null && runNumber !== null
            ? `${workflow} #${runNumber}`
            : null,
        buildNumber: int(runNumber),
      };
    },
  },
  {
    provider: "gitlab",
    detect: (env) => v(env, "GITLAB_CI") === "true",
    read: (env) => {
      const iid = v(env, "CI_PIPELINE_IID");
      return {
        branch:
          v(env, "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME") ??
          v(env, "CI_COMMIT_BRANCH"),
        parentBranch: v(env, "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"),
        ciBuildId: prefixed("gitlab", v(env, "CI_PIPELINE_ID")),
        buildName: iid === null ? null : `pipeline #${iid}`,
        buildNumber: int(iid),
      };
    },
  },
  {
    provider: "circleci",
    detect: (env) => v(env, "CIRCLECI") === "true",
    read: (env) => ({
      branch: v(env, "CIRCLE_TAG") === null ? v(env, "CIRCLE_BRANCH") : null,
      parentBranch: null,
      ciBuildId: prefixed("circleci", v(env, "CIRCLE_WORKFLOW_ID")),
      buildName: null,
      buildNumber: int(v(env, "CIRCLE_BUILD_NUM")),
    }),
  },
  {
    provider: "jenkins",
    detect: (env) => v(env, "JENKINS_URL") !== null,
    read: (env) => ({
      branch:
        v(env, "TAG_NAME") !== null
          ? null
          : (v(env, "CHANGE_BRANCH") ??
            v(env, "BRANCH_NAME") ??
            v(env, "GIT_BRANCH")?.replace(/^origin\//, "") ??
            null),
      parentBranch: v(env, "CHANGE_TARGET"),
      ciBuildId: prefixed("jenkins", v(env, "BUILD_TAG")),
      buildName: null,
      buildNumber: int(v(env, "BUILD_NUMBER")),
    }),
  },
  {
    provider: "buildkite",
    detect: (env) => v(env, "BUILDKITE") === "true",
    read: (env) => {
      const base = v(env, "BUILDKITE_PULL_REQUEST_BASE_BRANCH");
      return {
        branch:
          v(env, "BUILDKITE_TAG") === null ? v(env, "BUILDKITE_BRANCH") : null,
        parentBranch: base === "false" ? null : base,
        ciBuildId: prefixed("buildkite", v(env, "BUILDKITE_BUILD_ID")),
        buildName: null,
        buildNumber: int(v(env, "BUILDKITE_BUILD_NUMBER")),
      };
    },
  },
  {
    provider: "azure",
    detect: (env) => v(env, "TF_BUILD")?.toLowerCase() === "true",
    read: (env) => {
      const number = v(env, "BUILD_BUILDNUMBER");
      return {
        branch:
          headRef(v(env, "SYSTEM_PULLREQUEST_SOURCEBRANCH")) ??
          headRef(v(env, "BUILD_SOURCEBRANCH")),
        parentBranch: headRef(v(env, "SYSTEM_PULLREQUEST_TARGETBRANCH")),
        ciBuildId: prefixed("azure", v(env, "BUILD_BUILDID")),
        buildName: number,
        buildNumber: int(number),
      };
    },
  },
  {
    provider: "bitbucket",
    detect: (env) => v(env, "BITBUCKET_BUILD_NUMBER") !== null,
    read: (env) => ({
      branch: v(env, "BITBUCKET_BRANCH"),
      parentBranch: v(env, "BITBUCKET_PR_DESTINATION_BRANCH"),
      ciBuildId: prefixed("bitbucket", v(env, "BITBUCKET_PIPELINE_UUID")),
      buildName: null,
      buildNumber: int(v(env, "BITBUCKET_BUILD_NUMBER")),
    }),
  },
];

/** The CI system this process runs in, and what it says; null outside CI. */
export function detectCi(env: Env): CiInfo | null {
  const row = ROWS.find((r) => r.detect(env));
  return row ? { provider: row.provider, ...row.read(env) } : null;
}

/** The checked-out branch, or null when git is missing, slow, or HEAD is detached. */
export function gitBranch(cwd?: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 2_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}
