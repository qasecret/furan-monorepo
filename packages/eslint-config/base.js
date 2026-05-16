// @ts-check
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
    },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "**/node_modules/**"],
  },
];
