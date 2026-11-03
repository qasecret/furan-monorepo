import { describe, expect, it } from "vitest";

import sidebars from "../sidebars";
import { sections } from "../src/landing";

type Item = string | { type: string; id?: string; items?: Item[] };

const docIds = (items: Item[]): string[] =>
  items.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item.type === "category") return docIds(item.items ?? []);
    return item.id ? [item.id] : [];
  });

describe("home page", () => {
  it("links every sidebar page except the overview, and nothing else", () => {
    const sidebar = docIds(sidebars.docs as Item[]).filter(
      (id) => id !== "README",
    );
    const home = sections.flatMap((section) =>
      section.links.map((link) => link.doc),
    );
    expect([...home].sort()).toEqual([...sidebar].sort());
  });
});
