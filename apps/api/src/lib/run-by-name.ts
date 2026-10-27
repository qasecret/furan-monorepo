/**
 * Who ran a build, as the batch header and the diff viewer show it: the
 * build's user's "First Last", else whichever of the two is set; null when the
 * build has no user or the user has neither (`builds.getById` and
 * `runs.getById` both name them this way).
 */
export function runByDisplayName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  return firstName || lastName
    ? `${firstName ?? ""} ${lastName ?? ""}`.trim()
    : null;
}
