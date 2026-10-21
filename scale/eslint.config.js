import config from "@furan/eslint-config/node.js";

export default [
  ...config,
  {
    // Generated reports and the harness's own Next build output (gitignored).
    ignores: ["out/**", ".next-scale/**"],
  },
];
