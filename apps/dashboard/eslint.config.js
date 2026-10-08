import config from "@furan/eslint-config/node.js";

/**
 * Design-token ratchet. `@furan/no-raw-palette` is an error for every file under
 * `src/` EXCEPT the paths listed here, which still contain raw palette classes
 * and are migrated slice by slice. A migration PR deletes its entries; the list
 * must be empty by the end of the design-foundation program.
 *
 * Paths are relative to `apps/dashboard`. Do NOT add entries to hide new code.
 */
export const UNMIGRATED = [
  // PR 2
  "src/app/(protected)/_components/**",
  "src/app/(protected)/error.tsx",
  "src/app/(protected)/inbox/**",
  "src/app/(protected)/projects/[projectId]/builds/**",
  "src/app/(protected)/projects/[projectId]/_components/**",
  "src/app/(protected)/projects/[projectId]/layout.tsx",
  "src/app/(protected)/projects/[projectId]/page.tsx",
  "src/components/tour/**",
  "src/components/triage/**",
  // PR 3
  "src/app/(protected)/projects/[projectId]/runs/**",
  "src/components/diff-viewer/**",
  // PR 4
  "src/app/(protected)/admin/**",
  "src/app/(protected)/analytics/**",
  "src/app/(protected)/account/**",
  "src/app/(protected)/projects/[projectId]/settings/**",
  "src/app/(protected)/projects/[projectId]/variations/**",
  "src/app/(protected)/projects/*.tsx",
  "src/app/(protected)/projects/_components/**",
  // PR 5
  "src/app/(public)/**",
  "src/app/not-found.tsx",
  "src/app/page.tsx",
  "src/components/landing/**",
];

// minimatch treats ( ) [ ] as special; route groups and dynamic segments contain them.
const esc = (p) => p.replace(/[()[\]]/g, "\\$&");

export default [
  ...config,
  {
    ignores: [".next/**", "next-env.d.ts", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: UNMIGRATED.map(esc),
    rules: { "@furan/no-raw-palette": "error" },
  },
];
