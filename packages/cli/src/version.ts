import { createRequire } from "node:module";

/** This package's version, read from its package.json (one level above dist/ and src/). */
export const VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
