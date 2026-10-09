import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApiError, type ApiClient } from "../clients/api-client.js";
import { capture } from "../clients/virtual-sdk.js";
import { loadSeed, principal } from "../seed/load-seed.js";

/**
 * The data the visual sweep's project-scoped routes render: one project with a
 * build holding an UNRESOLVED run (a changed screenshot against an approved
 * baseline), so the diff viewer, build and run pages all have real content.
 */
export interface VisualFixture {
  projectId: string;
  buildId: string;
  unresolvedRunId: string;
}

const FIXTURE_FILE = fileURLToPath(
  new URL("../../.visual-sweep.json", import.meta.url),
);

/** Fixed name, so a `before` and an `after` run render the same project. */
const PROJECT_NAME = "visual-sweep";
const BUILD_NAME = "visual-sweep-build";
const CHECKPOINT = "home";
const BRANCH = "main";

function readFixture(): VisualFixture | null {
  try {
    return JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as VisualFixture;
  } catch {
    return null;
  }
}

/**
 * Reuse `e2e/.visual-sweep.json` while its project still exists on this stack
 * (so the `before` and `after` sweeps capture identical data); otherwise create
 * the fixture and write the file. Either way, the project is made the sweep
 * admin's default (see {@link makeAdminDefault}). Requires the Playwright
 * globalSetup seed.
 */
export async function ensureVisualFixture(
  api: ApiClient,
): Promise<VisualFixture> {
  const admin = loadSeed().bootstrapAdminJwt;
  const fixture = await reuseOrCreate(api);
  await makeAdminDefault(api, admin, fixture.projectId);
  return fixture;
}

/**
 * The sweep's admin session renders the project-less routes (`/inbox`) for its
 * CURRENT project, which is its default project. An admin sees every project,
 * so with no default and 2+ projects it has none, and `/inbox` would only ever
 * show "No project assigned" — the batches table, and its enforced contrast
 * check, would go unswept. Adds `projectId` to the admin's memberships (keeping
 * every existing one; `setUserProjects` replaces the whole set) and makes it
 * the default. A no-op when that is already so.
 */
async function makeAdminDefault(
  api: ApiClient,
  admin: string,
  projectId: string,
): Promise<void> {
  const me = await api.me(admin);
  const memberOf = await api.listUserProjects(admin, me.id);
  if (me.defaultProjectId === projectId && memberOf.includes(projectId)) return;
  await api.setUserProjects(admin, {
    userId: me.id,
    projectIds: [...new Set([...memberOf, projectId])],
    defaultProjectId: projectId,
  });
}

async function reuseOrCreate(api: ApiClient): Promise<VisualFixture> {
  const seed = loadSeed();
  const admin = seed.bootstrapAdminJwt;
  const pat = principal(seed, "owner").pat;

  const existing = readFixture();
  if (existing) {
    const projects = await api.listProjects(admin);
    if (projects.some((p) => p.id === existing.projectId)) return existing;
  }

  let projectId: string;
  try {
    projectId = (await api.createProject(admin, { name: PROJECT_NAME })).id;
  } catch (e) {
    // The project outlived its fixture file (deleted or stale): adopt it.
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    const found = (await api.listProjects(admin)).find(
      (p) => p.name === PROJECT_NAME,
    );
    if (!found) throw e;
    projectId = found.id;
  }

  const base = await capture(api, {
    pat,
    projectId,
    branchName: BRANCH,
    checkpointName: CHECKPOINT,
    fixture: "baseline",
    buildName: BUILD_NAME,
  });
  // An adopted project may already hold this baseline, so the capture comes
  // back "passed"; only a new or unresolved run needs (and accepts) approval.
  if (base.status !== "passed") await api.approveRun(admin, base.runId);
  const changed = await capture(api, {
    pat,
    projectId,
    branchName: BRANCH,
    checkpointName: CHECKPOINT,
    fixture: "changed",
    buildName: BUILD_NAME,
  });
  if (changed.status !== "unresolved") {
    throw new Error(
      `visual fixture: expected the changed capture to be unresolved, got "${changed.status}"`,
    );
  }

  const fixture: VisualFixture = {
    projectId,
    buildId: changed.buildId,
    unresolvedRunId: changed.runId,
  };
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2));
  return fixture;
}
