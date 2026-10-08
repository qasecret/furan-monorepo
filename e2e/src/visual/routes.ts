import type { VisualFixture } from "./fixture.js";

/**
 * Every dashboard route the visual sweep captures (spec §7.1).
 *
 * `enforceContrast` is the per-route ratchet: `false` → axe `color-contrast`
 * violations are only reported (as test annotations); `true` → they fail the
 * test. Each design-foundation slice PR flips its own routes to `true` as it
 * leaves the lint `UNMIGRATED` list, so "migrated" means "AA-verified".
 */
export interface VisualRoute {
  name: string;
  path: string;
  enforceContrast: boolean;
}

const ADMIN_AREAS = [
  "api-keys",
  "audit-log",
  "auto-rules",
  "installations",
  "members",
  "projects",
] as const;

export function staticRoutes(f: VisualFixture): VisualRoute[] {
  const P = `/projects/${f.projectId}`;
  return [
    { name: "landing", path: "/", enforceContrast: false },
    { name: "login", path: "/login", enforceContrast: false },
    { name: "inbox", path: "/inbox", enforceContrast: false },
    { name: "analytics", path: "/analytics", enforceContrast: false },
    { name: "account-tokens", path: "/account/tokens", enforceContrast: false },
    ...ADMIN_AREAS.map((x) => ({
      name: `admin-${x}`,
      path: `/admin/${x}`,
      enforceContrast: false,
    })),
    {
      name: "admin-project-members",
      path: `/admin/projects/${f.projectId}/members`,
      enforceContrast: false,
    },
    { name: "projects", path: "/projects", enforceContrast: false },
    { name: "project", path: P, enforceContrast: false },
    { name: "builds", path: `${P}/builds`, enforceContrast: false },
    { name: "build", path: `${P}/builds/${f.buildId}`, enforceContrast: false },
    { name: "runs", path: `${P}/runs`, enforceContrast: false },
    {
      name: "run",
      path: `${P}/runs/${f.unresolvedRunId}`,
      enforceContrast: false,
    },
    { name: "settings", path: `${P}/settings`, enforceContrast: false },
    { name: "variations", path: `${P}/variations`, enforceContrast: false },
  ];
}

/**
 * Routes whose IDs aren't known up front: the sweep opens `from`, follows the
 * first link matching each `via` pattern in turn, then takes the FIRST
 * `a[href]` whose pathname matches `href` and captures that page. Zero
 * matching links fails the test — a missing link is itself a regression.
 *
 * Where the links actually are (checked in the DOM, 2026-10-08):
 *  - `/runs/:runId/diffs/:diffId` is linked only from a variation's history
 *    table, so `diff` goes variations → variation → diff. (The run page and the
 *    diff viewer render no `/diffs/` or `/checkpoints/` anchors.)
 *  - `/runs/:runId/checkpoints/:checkpointId` has no anchor anywhere — it is
 *    reached by `router.push`/`replace` only — so it has no entry here. The
 *    `run` static route covers it: `/runs/:runId` redirects to the run's first
 *    checkpoint, which is what that screenshot shows.
 */
export const DISCOVERED: ReadonlyArray<{
  name: string;
  from: (f: VisualFixture) => string;
  /** Links to follow, in order, from `from` before looking for `href`. */
  via?: ReadonlyArray<RegExp>;
  href: RegExp;
  enforceContrast: boolean;
}> = [
  {
    name: "diff",
    from: (f) => `/projects/${f.projectId}/variations`,
    via: [/\/variations\/[^/]+$/],
    href: /\/diffs\/[^/]+$/,
    enforceContrast: false,
  },
  {
    name: "variation",
    from: (f) => `/projects/${f.projectId}/variations`,
    href: /\/variations\/[^/]+$/,
    enforceContrast: false,
  },
];
