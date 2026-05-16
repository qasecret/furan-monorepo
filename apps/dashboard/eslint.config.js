import config from "@furan/eslint-config/node.js";
export default [
  ...config,
  {
    ignores: [".next/**", "next-env.d.ts", "node_modules/**"],
  },
];
