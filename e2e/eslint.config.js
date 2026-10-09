import config from "@furan/eslint-config/node.js";

export default [
  ...config,
  {
    // Playwright's HTML report and run artifacts (gitignored, generated).
    ignores: ["playwright-report/**", "test-results/**", "visual-out/**"],
  },
];
