// @ts-check
import base from "./base.js";
import noRawDrizzle from "./no-raw-drizzle.js";

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
        },
      },
    },
    rules: {
      "@furan/no-raw-drizzle": "error",
    },
  },
];
