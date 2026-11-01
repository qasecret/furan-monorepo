import { describe, expect, it } from "vitest";

import { testTitle } from "../src/names.js";

describe("testTitle", () => {
  it("is the title path when the project has no name", () => {
    expect(
      testTitle({
        titlePath: ["cart.spec.ts", "adds an item"],
        project: { name: "" },
      }),
    ).toBe("cart.spec.ts › adds an item");
  });

  it("leads with the project, so projects sharing a browser keep apart", () => {
    const light = testTitle({
      titlePath: ["cart.spec.ts", "adds an item"],
      project: { name: "light" },
    });
    const dark = testTitle({
      titlePath: ["cart.spec.ts", "adds an item"],
      project: { name: "dark" },
    });
    expect(light).toBe("light › cart.spec.ts › adds an item");
    expect(dark).not.toBe(light);
  });
});
