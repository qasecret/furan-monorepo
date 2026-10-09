import config from "@furan/eslint-config/node.js";

export default [
  ...config,
  {
    ignores: [".next/**", "next-env.d.ts", "node_modules/**"],
  },
  {
    // Design tokens only: no raw neutral palette, no `dark:` colour overrides,
    // no arbitrary colours or font sizes anywhere in the app. Use the semantic
    // tokens in src/app/tokens.css (codemod: scripts/codemod-tokens/cli.ts).
    files: ["src/**/*.{ts,tsx}"],
    rules: { "@furan/no-raw-palette": "error" },
  },
];
