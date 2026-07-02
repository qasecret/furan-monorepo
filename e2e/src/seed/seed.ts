/**
 * Seed the running deployment with the RBAC principals + projects the tests
 * need, via the real admin API (the images are distroless — no CLI exec).
 *
 * Phase 1 stub: real implementation lands in Phase 2 (Task 9). Kept as a typed
 * no-op so the orchestrator wiring typechecks and runs end-to-end now.
 */
export interface SeededPrincipal {
  email: string;
  role: "owner" | "admin" | "editor" | "guest";
  pat: string;
}

export interface SeedResult {
  principals: SeededPrincipal[];
}

export async function seedAll(): Promise<SeedResult> {
  // TODO(Phase 2 / Task 9): log in as bootstrap admin, promote owner, create
  // admin/editor/guest, projects + memberships, mint PATs, write .seed.json.
  await Promise.resolve();
  return { principals: [] };
}
