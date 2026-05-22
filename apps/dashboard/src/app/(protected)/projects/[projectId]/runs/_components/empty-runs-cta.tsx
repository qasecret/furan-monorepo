"use client";

import Link from "next/link";

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
      className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-700"
      data-testid="empty-runs-cta"
    >
      <p className="font-medium">No runs yet for this project.</p>
      <p className="mt-1 text-neutral-600">
        Connect the Furan SDK to start sending runs. Project id:{" "}
        <code className="font-mono text-xs">{projectId}</code>
      </p>
      <pre className="mt-3 overflow-x-auto rounded bg-neutral-900 text-neutral-100 p-3 text-xs">
        {`# Gradle dependency
implementation("io.github.qasecret:furan-selenium:0.7.0")

# Env vars for CI
FURAN_API_URL=https://furan.example.com
FURAN_API_TOKEN=furan_pat_…           # create one under Settings → Tokens
FURAN_PROJECT_ID=${projectId}
FURAN_BUILD_ID=\${GITHUB_RUN_ID:-local}`}
      </pre>
      <Link
        href="/account/tokens"
        className="mt-3 inline-block text-blue-700 hover:underline"
        data-testid="empty-runs-cta-token-link"
      >
        Create a personal access token →
      </Link>
    </div>
  );
}
