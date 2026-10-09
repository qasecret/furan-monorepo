import config from "@furan/eslint-config/node.js";

/**
 * Design-token ratchet. `@furan/no-raw-palette` is an error for every file under
 * `src/` EXCEPT the paths listed here, which still contain raw palette classes
 * and are migrated slice by slice. A migration PR deletes its entries; the list
 * must be empty by the end of the design-foundation program.
 *
 * Paths are relative to `apps/dashboard`. Do NOT add entries to hide new code.
 */
export const UNMIGRATED = [];

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
