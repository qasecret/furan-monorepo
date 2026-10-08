/**
 * The capability denominator for measured E2E coverage. Every test tags the
 * capability IDs it exercises (via `coverAnnotations`); the reporter renders an
 * `area → capability → covered? → pass/fail` matrix. `configGated: true` marks a
 * capability we deliberately don't run by default (real cloud VLM, real GitHub,
 * real Kotlin SDK when no JDK) so "not covered by choice" is distinct from
 * "not covered by oversight".
 */
export interface Capability {
  id: string;
  area: string;
  label: string;
  configGated?: boolean;
}

export const CAPABILITIES: Capability[] = [
  // deploy
  { id: "deploy.livez", area: "deploy", label: "liveness 200" },
  { id: "deploy.readyz", area: "deploy", label: "deep readiness all-ok" },
  { id: "deploy.openapi", area: "deploy", label: "openapi shape sane" },
  { id: "deploy.metrics", area: "deploy", label: "metrics scrape has hardening series" },
  // sdk
  { id: "sdk.virtual.happy", area: "sdk", label: "virtual-SDK create→upload→complete→verdict" },
  { id: "sdk.kotlin.smoke", area: "sdk", label: "real Kotlin SDK smoke", configGated: true },
  // diff
  { id: "diff.identical_passes", area: "diff", label: "identical → passed" },
  { id: "diff.engine.odiff", area: "diff", label: "odiff engine diff" },
  { id: "diff.engine.pixelmatch", area: "diff", label: "pixelmatch engine diff" },
  { id: "diff.engine.looks_same", area: "diff", label: "looks-same engine diff" },
  { id: "diff.axe_a11y", area: "diff", label: "axe a11y regions" },
  { id: "diff.ignore_region", area: "diff", label: "ignore region suppresses diff" },
  { id: "diff.layout_match", area: "diff", label: "layout match-level suppresses shift" },
  { id: "diff.vlm_invoked", area: "diff", label: "VLM layer invoked + persisted", configGated: true },
  // rbac
  { id: "rbac.owner_all_gates", area: "rbac", label: "owner passes admin gates" },
  { id: "rbac.editor_scoped", area: "rbac", label: "editor blocked from admin, allowed on member project" },
  { id: "rbac.guest_rejected", area: "rbac", label: "guest rejected" },
  { id: "rbac.jwt_and_pat", area: "rbac", label: "JWT + PAT both authenticate" },
  { id: "rbac.deactivation", area: "rbac", label: "deactivation effective next request" },
  { id: "rbac.sod", area: "rbac", label: "last_owner / last_admin / owner_protected" },
  // branch / baseline / auto-rules / retention
  { id: "branch.first_baseline", area: "branch", label: "manual first-baseline default" },
  { id: "branch.parent_fallback", area: "branch", label: "parent-PR single-hop fallback" },
  { id: "branch.cross_merge", area: "branch", label: "cross-branch merge fan-out" },
  { id: "branch.auto_rule", area: "branch", label: "auto-rule resolves known diff" },
  { id: "branch.retention", area: "branch", label: "retention TTL + orphan reconcile" },
  // storage
  { id: "storage.s3_roundtrip", area: "storage", label: "S3 serve screenshot through UI/proxy" },
  { id: "storage.hdd_roundtrip", area: "storage", label: "HDD serve screenshot through UI/proxy" },
  // ui
  { id: "ui.login", area: "ui", label: "dashboard login → landing" },
  { id: "ui.builds_list", area: "ui", label: "builds list renders + SSE update" },
  { id: "ui.diff_viewer", area: "ui", label: "diff viewer opens" },
  { id: "ui.admin_surfaces", area: "ui", label: "admin members/projects/auto-rules/settings" },
];
