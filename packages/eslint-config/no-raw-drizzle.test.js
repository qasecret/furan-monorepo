import { RuleTester } from "eslint";
import { describe, expect, test } from "vitest";

import noRawDrizzle from "./no-raw-drizzle.js";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("@furan/no-raw-drizzle", () => {
  test("flags drizzle-orm import in apps/api", () => {
    expect(() =>
      ruleTester.run("no-raw-drizzle", noRawDrizzle, {
        valid: [],
        invalid: [
          {
            code: `import { sql } from "drizzle-orm";`,
            filename: "/repo/apps/api/src/foo.ts",
            errors: [{ messageId: "banned" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("flags drizzle-orm subpath import outside packages/db", () => {
    expect(() =>
      ruleTester.run("no-raw-drizzle", noRawDrizzle, {
        valid: [],
        invalid: [
          {
            code: `import { pgTable } from "drizzle-orm/pg-core";`,
            filename: "/repo/apps/api/src/foo.ts",
            errors: [{ messageId: "banned" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("allows drizzle-orm inside packages/db", () => {
    expect(() =>
      ruleTester.run("no-raw-drizzle", noRawDrizzle, {
        valid: [
          {
            code: `import { sql } from "drizzle-orm";`,
            filename: "/repo/packages/db/src/scope.ts",
          },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });

  test("does not flag other imports", () => {
    expect(() =>
      ruleTester.run("no-raw-drizzle", noRawDrizzle, {
        valid: [
          {
            code: `import { z } from "zod";`,
            filename: "/repo/apps/api/src/foo.ts",
          },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });
});
