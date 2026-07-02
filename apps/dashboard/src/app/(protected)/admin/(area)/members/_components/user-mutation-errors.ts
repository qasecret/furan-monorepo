// Shared mapping of the API's user-mutation error codes to human messages, so
// every caller of PATCH /users/:id (ChangeRoleCell, DeactivateButton) surfaces
// the same reasons. Keep the codes in sync with the server guards in
// apps/api/src/routes/users-admin-guards.ts.
export const USER_MUTATION_ERROR: Record<string, string> = {
  cannot_change_own_role: "You can't change your own role — ask another admin.",
  cannot_disable_self: "You can't deactivate your own account.",
  last_admin: "At least one active admin must remain.",
  last_owner: "At least one active owner must remain.",
  owner_protected: "Only an owner can change or deactivate another owner.",
};

/** Read the `{ code }` from a failed API response (empty string if none). */
export async function readApiErrorCode(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { code?: string }).code ?? "";
  } catch {
    // non-JSON body — caller falls back to a generic message
    return "";
  }
}
