import { test, expect } from "vitest";

import { PHASE } from "./index.js";

test("placeholder export until P1.C populates real schemas", () => {
  expect(PHASE).toBe("1.A-skeleton");
});
