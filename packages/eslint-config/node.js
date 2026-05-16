// @ts-check
import base from "./base.js";

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
  },
];
