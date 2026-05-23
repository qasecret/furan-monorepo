"use client";

import Link from "next/link";

import { FURAN_SDK_VERSION } from "@/lib/sdk-version";

interface Props {
  projectId: string;
}

/**
 * Shown on the runs list when a project has zero runs AND no filter is
 * active. Different from the filter-active empty state ("No runs match.")
 * which keeps today's brief copy. Mirrors EmptyBuildsState from PR #52.
 */
export function EmptyRunsCta({ projectId }: Props) {
  return (
    <div
      className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/50 p-6 text-sm text-zinc-300"
      data-testid="empty-runs-cta"
    >
      <p className="font-medium text-white">No runs yet for this project.</p>
      <p className="mt-1 text-zinc-400">
        Connect the Furan SDK to start sending runs. Project id:{" "}
        <code className="font-mono text-xs text-zinc-300">{projectId}</code>
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 text-zinc-100 p-3 text-xs">
        {`# Gradle dependency
implementation("io.github.qasecret:furan-selenium:${FURAN_SDK_VERSION}")

# Env vars for CI
FURAN_API_URL=https://furan.example.com
FURAN_API_TOKEN=furan_pat_…           # create one at /account/tokens
FURAN_PROJECT_ID=${projectId}
FURAN_BUILD_ID=\${GITHUB_RUN_ID:-local}`}
      </pre>
      <Link
        href="/account/tokens"
        className="mt-3 inline-block text-brand hover:underline"
        data-testid="empty-runs-cta-token-link"
      >
        Create a personal access token →
      </Link>
    </div>
  );
}
