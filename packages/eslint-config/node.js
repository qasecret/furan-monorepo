// @ts-check
import base from "./base.js";
import noRawDrizzle from "./no-raw-drizzle.js";
import noRawPalette from "./no-raw-palette.js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...base,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    plugins: {
      "@furan": {
        rules: {
          "no-raw-drizzle": noRawDrizzle,
          // Registered only; enabled per-app (see apps/dashboard/eslint.config.js).
          "no-raw-palette": noRawPalette,
        },
      },
    },
    rules: {
      "@furan/no-raw-drizzle": "error",
    },
  },
];
