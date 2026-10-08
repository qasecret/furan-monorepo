// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runCodemod } from "../scripts/codemod-tokens/cli";
import { HOVER_OR_MUTED, PAIR_MAP } from "../scripts/codemod-tokens/map";
import {
  transformClassString,
  transformSource,
} from "../scripts/codemod-tokens/transform";

// ---------------------------------------------------------------------------
// Brief tests (task 5) — exact.
// ---------------------------------------------------------------------------

test("pairs → tokens", () => {
  expect(
    transformClassString("border-zinc-200 dark:border-zinc-800 p-2").out,
  ).toBe("border-edge p-2");
  expect(transformClassString("text-zinc-950 dark:text-white").out).toBe(
    "text-fg",
  );
});
test("variants and dark-order", () => {
  expect(
    transformClassString("hover:bg-zinc-100 dark:hover:bg-zinc-900").out,
  ).toBe("hover:bg-hover");
  expect(
    transformClassString("hover:text-zinc-950 hover:dark:text-white").out,
  ).toBe("hover:text-fg");
  expect(transformClassString("bg-zinc-100 dark:bg-zinc-900").out).toBe(
    "bg-muted",
  );
  expect(
    transformClassString(
      "data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-900",
    ).out,
  ).toBe("data-[highlighted]:bg-hover");
});
test("light opacity carried", () => {
  expect(transformClassString("bg-zinc-50/80 dark:bg-zinc-950/50").out).toBe(
    "bg-sunken/80",
  );
  expect(transformClassString("bg-white/70 dark:bg-black/60").out).toBe(
    "bg-canvas/70",
  );
});
test("hue pairs → status", () => {
  expect(transformClassString("text-red-700 dark:text-red-400").out).toBe(
    "text-status-failed-text",
  );
  expect(
    transformClassString("bg-emerald-100 dark:bg-emerald-500/10").out,
  ).toBe("bg-status-passed/10");
  expect(transformClassString("bg-amber-500 dark:bg-amber-400").out).toBe(
    "bg-status-unresolved",
  );
  expect(
    transformClassString("border-blue-300 dark:border-blue-500/20").out,
  ).toBe("border-status-running/25");
});
test("lone text-zinc-500 maps only without a dark text partner", () => {
  expect(transformClassString("text-zinc-500 text-xs").out).toBe(
    "text-fg-muted text-xs",
  );
});
test("split pair across strings is never half-converted", () => {
  const r = transformSource(
    `cn("text-zinc-600", on && "dark:text-zinc-400")`,
    "a.tsx",
  );
  expect(r.out).toBe(`cn("text-zinc-600", on && "dark:text-zinc-400")`);
  expect(r.residue.map((x) => x.cls)).toEqual([
    "text-zinc-600",
    "dark:text-zinc-400",
  ]);
});
test("unmapped pairs are left intact and reported", () => {
  const r = transformClassString("text-zinc-400 dark:text-zinc-600");
  expect(r.out).toBe("text-zinc-400 dark:text-zinc-600");
  expect(r.residue).toEqual(["text-zinc-400", "dark:text-zinc-600"]);
});
test("scrims untouched", () => {
  expect(transformClassString("bg-black/70 text-white").out).toBe(
    "bg-black/70 text-white",
  );
});
const FIXTURE = [
  `const V = { ghost: "text-zinc-600 dark:text-zinc-400" };`,
  `const el = <div className='border-zinc-200 dark:border-zinc-800' />;`,
  "const t = `bg-white dark:bg-zinc-950 ${x}`;",
  `const b = cva("bg-zinc-100 dark:bg-zinc-900", { variants: { on: { true: "hover:bg-zinc-100 dark:hover:bg-zinc-900" } } });`,
].join("\n");
test("object-literal, JSX, template and cva strings are all visited; quotes and edge whitespace preserved", () => {
  expect(transformSource(FIXTURE, "f.tsx").out).toBe(
    [
      `const V = { ghost: "text-fg-secondary" };`,
      `const el = <div className='border-edge' />;`,
      "const t = `bg-raised ${x}`;",
      `const b = cva("bg-muted", { variants: { on: { true: "hover:bg-hover" } } });`,
    ].join("\n"),
  );
});
test("idempotent", () => {
  const once = transformSource(FIXTURE, "f.tsx").out;
  expect(transformSource(once, "f.tsx").out).toBe(once);
});
test("residue carries 1-based line numbers", () => {
  const r = transformSource(
    `// a\n// b\nconst c = "text-zinc-400 dark:text-zinc-600";`,
    "f.tsx",
  );
  expect(r.residue[0]).toEqual({
    line: 3,
    cls: "text-zinc-400",
    reason: "unmapped",
  });
});

// ---------------------------------------------------------------------------
// Extra coverage for the controller's resolutions and edge cases.
// ---------------------------------------------------------------------------

describe("mapping table", () => {
  test("every table key round-trips to a token class", () => {
    for (const [key, token] of PAIR_MAP) {
      const [prop, colours] = key.split(":") as [string, string];
      const [light, dark] = colours.split("|") as [string, string];
      const expected = token === HOVER_OR_MUTED ? "muted" : token;
      const r = transformClassString(`${prop}-${light} dark:${prop}-${dark}`);
      expect(r.out, key).toBe(`${prop}-${expected}`);
      expect(r.residue, key).toEqual([]);
    }
  });

  test("has exactly the reviewed 37 pair entries", () => {
    expect(PAIR_MAP.size).toBe(37);
  });

  test("ring-offset pairs map to canvas", () => {
    expect(
      transformClassString("ring-offset-white dark:ring-offset-zinc-950").out,
    ).toBe("ring-offset-canvas");
  });

  test("HOVER_OR_MUTED picks hover for interaction variants only", () => {
    for (const v of [
      "focus",
      "focus-visible",
      "active",
      "group-hover",
      "aria-selected",
      "data-[state=open]",
    ]) {
      expect(
        transformClassString(`${v}:bg-zinc-100 dark:${v}:bg-zinc-800`).out,
      ).toBe(`${v}:bg-hover`);
    }
    expect(transformClassString("md:bg-zinc-100 dark:md:bg-zinc-800").out).toBe(
      "md:bg-muted",
    );
  });

  test("deliberately unmapped pairs are residue", () => {
    for (const s of [
      "text-zinc-300 dark:text-zinc-700",
      "text-white dark:text-zinc-900",
      "bg-zinc-900 dark:bg-zinc-100",
      "bg-white dark:bg-zinc-800",
      "bg-zinc-400 dark:bg-zinc-600",
      "from-zinc-50 dark:from-zinc-900",
      "ring-zinc-200 dark:ring-zinc-800",
      "text-gray-900 dark:text-white",
    ]) {
      const r = transformClassString(s);
      expect(r.out, s).toBe(s);
      expect(r.residue, s).toEqual(s.split(" "));
    }
  });
});

describe("pairing", () => {
  test("sided borders pair only with the same sided property and keep it", () => {
    expect(
      transformClassString("border-t-zinc-200 dark:border-t-zinc-800").out,
    ).toBe("border-t-edge");
    expect(
      transformClassString("divide-zinc-200 dark:divide-zinc-800").out,
    ).toBe("divide-edge");
    const r = transformClassString("border-t-zinc-200 dark:border-zinc-800");
    expect(r.out).toBe("border-t-zinc-200 dark:border-zinc-800");
    expect(r.residue).toEqual(["border-t-zinc-200", "dark:border-zinc-800"]);
  });

  test("variant chains must match exactly (minus dark)", () => {
    const r = transformClassString("bg-zinc-100 dark:hover:bg-zinc-900");
    expect(r.out).toBe("bg-zinc-100 dark:hover:bg-zinc-900");
    expect(r.residue).toEqual(["bg-zinc-100", "dark:hover:bg-zinc-900"]);
  });

  test("a dark class before its light partner still pairs, in the light position", () => {
    expect(
      transformClassString("p-2 dark:border-zinc-800 m-1 border-zinc-200").out,
    ).toBe("p-2 m-1 border-edge");
  });

  test("light opacity is carried; dark opacity is dropped", () => {
    expect(transformClassString("bg-zinc-100 dark:bg-zinc-900/50").out).toBe(
      "bg-muted",
    );
  });

  test("important is kept, in the author's position", () => {
    expect(transformClassString("!bg-zinc-100 dark:!bg-zinc-900").out).toBe(
      "!bg-muted",
    );
    expect(transformClassString("bg-zinc-100! dark:bg-zinc-900").out).toBe(
      "bg-muted!",
    );
    expect(transformClassString("bg-zinc-100 dark:bg-zinc-900!").out).toBe(
      "bg-muted!",
    );
  });

  test("whitespace inside a changed string collapses; edges are kept", () => {
    expect(
      transformClassString("  p-2   bg-zinc-100  dark:bg-zinc-900 ").out,
    ).toBe("  p-2 bg-muted ");
  });

  test("strings without a change are returned verbatim", () => {
    expect(transformClassString("p-2   m-1").out).toBe("p-2   m-1");
  });
});

describe("hue pairs", () => {
  test("emerald and green are one family", () => {
    expect(
      transformClassString("text-emerald-700 dark:text-green-400").out,
    ).toBe("text-status-passed-text");
  });

  test("yellow → aborted; sided borders get /25", () => {
    expect(
      transformClassString("border-l-yellow-500 dark:border-l-yellow-400").out,
    ).toBe("border-l-status-aborted/25");
  });

  test("bg is a /10 tint for light shades ≤ 200 or opacity ≤ 20, else solid", () => {
    expect(transformClassString("bg-red-50 dark:bg-red-950").out).toBe(
      "bg-status-failed/10",
    );
    expect(transformClassString("bg-red-500/20 dark:bg-red-500").out).toBe(
      "bg-status-failed/10",
    );
    expect(transformClassString("bg-red-600 dark:bg-red-500/30").out).toBe(
      "bg-status-failed",
    );
  });

  test("text hue pairs ignore opacity", () => {
    expect(
      transformClassString("text-blue-700/80 dark:text-blue-400").out,
    ).toBe("text-status-running-text");
  });

  test("different families, other hues and other properties are residue (both sides)", () => {
    for (const s of [
      "text-red-600 dark:text-amber-400",
      "text-violet-600 dark:text-violet-400",
      "ring-red-500 dark:ring-red-400",
      "bg-red-600 dark:bg-zinc-900",
    ]) {
      const r = transformClassString(s);
      expect(r.out, s).toBe(s);
      expect(r.residue, s).toEqual(s.split(" "));
    }
  });
});

describe("lone classes", () => {
  test("a lone chromatic class is untouched and not residue", () => {
    const r = transformClassString("text-red-600 bg-black/50");
    expect(r.out).toBe("text-red-600 bg-black/50");
    expect(r.residue).toEqual([]);
  });

  test("lone neutral and orphan dark colour classes are residue", () => {
    const r = transformClassString("text-zinc-600 dark:bg-zinc-900 text-sm");
    expect(r.out).toBe("text-zinc-600 dark:bg-zinc-900 text-sm");
    expect(r.residue).toEqual(["text-zinc-600", "dark:bg-zinc-900"]);
  });

  test("lone text-zinc-500 keeps variants and opacity", () => {
    expect(transformClassString("hover:text-zinc-500/80").out).toBe(
      "hover:text-fg-muted/80",
    );
  });

  test("a missed text-zinc-500 pair is not rescued by the lone rule", () => {
    const r = transformClassString("text-zinc-500 dark:text-zinc-300");
    expect(r.out).toBe("text-zinc-500 dark:text-zinc-300");
    expect(r.residue).toEqual(["text-zinc-500", "dark:text-zinc-300"]);
  });

  test("lone text-zinc-500 is blocked by a surviving dark text class with the same chain", () => {
    const r = transformClassString(
      "text-zinc-400 text-zinc-500 dark:text-zinc-600",
    );
    expect(r.out).toBe("text-zinc-400 text-zinc-500 dark:text-zinc-600");
    expect(r.residue).toEqual([
      "text-zinc-400",
      "text-zinc-500",
      "dark:text-zinc-600",
    ]);
    // A dark text class on a different chain does not block it.
    expect(
      transformClassString("text-zinc-500 dark:hover:text-white").out,
    ).toBe("text-fg-muted dark:hover:text-white");
  });

  test("a dark text class consumed by another pair does not block it (keeps the codemod idempotent)", () => {
    const r = transformClassString(
      "text-zinc-900 dark:text-white text-zinc-500",
    );
    expect(r.out).toBe("text-fg text-fg-muted");
    expect(transformClassString(r.out).out).toBe(r.out);
  });

  test("lone text-zinc-500 is not half-converted across strings of one expression", () => {
    const src = `cn("text-zinc-500", on && "dark:text-zinc-300")`;
    const r = transformSource(src, "a.tsx");
    expect(r.out).toBe(src);
    expect(r.residue.map((x) => x.cls)).toEqual([
      "text-zinc-500",
      "dark:text-zinc-300",
    ]);
    const tpl = "const c = `text-zinc-500 ${x} dark:text-zinc-300`;";
    expect(transformSource(tpl, "a.tsx").out).toBe(tpl);
  });
});

describe("transformSource", () => {
  test("a token cut by ${} is dynamic residue and never pairs", () => {
    const src =
      "const c = `border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100${x ? ' o' : ''}`;";
    const r = transformSource(src, "a.tsx");
    expect(r.out).toBe(
      "const c = `border-edge text-zinc-900 dark:text-zinc-100${x ? ' o' : ''}`;",
    );
    expect(r.residue).toEqual([
      { line: 1, cls: "text-zinc-900", reason: "unmapped" },
      { line: 1, cls: "dark:text-zinc-100", reason: "dynamic" },
    ]);
  });

  test("dynamic fragments on either side of ${} are reported", () => {
    const r = transformSource(
      "const c = `p-2 dark:bg-${a} bg-zinc-${n}`;",
      "a.tsx",
    );
    expect(r.out).toBe("const c = `p-2 dark:bg-${a} bg-zinc-${n}`;");
    expect(r.residue).toEqual([
      { line: 1, cls: "dark:bg-", reason: "dynamic" },
      { line: 1, cls: "bg-zinc-", reason: "dynamic" },
    ]);
    const tail = transformSource("const c = `${v}bg-zinc-100 p-2`;", "a.tsx");
    expect(tail.out).toBe("const c = `${v}bg-zinc-100 p-2`;");
    expect(tail.residue).toEqual([
      { line: 1, cls: "bg-zinc-100", reason: "dynamic" },
    ]);
  });

  test("residue line is the line of the class inside a multi-line string", () => {
    const r = transformSource("const c = `p-2\n  text-zinc-600\n`;", "a.tsx");
    expect(r.residue).toEqual([
      { line: 2, cls: "text-zinc-600", reason: "unmapped" },
    ]);
  });

  test("module specifiers and non-class strings are untouched", () => {
    const src = [
      `import x from "bg-zinc-100 dark:bg-zinc-900";`,
      `export * from "text-zinc-950 dark:text-white";`,
      `const s = "hello   world";`,
    ].join("\n");
    const r = transformSource(src, "a.tsx");
    expect(r.out).toBe(src);
    expect(r.residue).toEqual([]);
  });

  test("clsx object keys and conditional branches are visited", () => {
    expect(
      transformSource(
        `clsx({ "bg-zinc-100 dark:bg-zinc-800": a }, b ? "text-zinc-950 dark:text-white" : "")`,
        "a.tsx",
      ).out,
    ).toBe(`clsx({ "bg-muted": a }, b ? "text-fg" : "")`);
  });
});

describe("cli", () => {
  function fixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "codemod-tokens-"));
    writeFileSync(
      join(dir, "a.tsx"),
      `export const A = <p className="text-zinc-600 dark:text-zinc-400 text-zinc-400 dark:text-zinc-600" />;\n`,
    );
    writeFileSync(join(dir, "b.ts"), `export const B = "p-2";\n`);
    return dir;
  }

  test("--dry-run writes nothing and prints residue plus a count", () => {
    const dir = fixtureDir();
    try {
      const before = readFileSync(join(dir, "a.tsx"), "utf8");
      const lines: string[] = [];
      const summary = runCodemod([dir, "--dry-run"], (l) => lines.push(l));
      expect(readFileSync(join(dir, "a.tsx"), "utf8")).toBe(before);
      expect(summary).toEqual({ files: 2, changed: 1, residue: 2 });
      const out = lines.join("\n");
      expect(out).toContain(
        '+export const A = <p className="text-fg-secondary text-zinc-400 dark:text-zinc-600" />;',
      );
      expect(lines).toContain(
        `${join(dir, "a.tsx")}:1 text-zinc-400 (unmapped)`,
      );
      expect(lines).toContain(
        `${join(dir, "a.tsx")}:1 dark:text-zinc-600 (unmapped)`,
      );
      expect(lines.at(-1)).toMatch(/1 file\(s\) would change, 2 residue/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without --dry-run files are rewritten in place", () => {
    const dir = fixtureDir();
    try {
      const summary = runCodemod([dir], () => {});
      expect(summary.changed).toBe(1);
      expect(readFileSync(join(dir, "a.tsx"), "utf8")).toBe(
        `export const A = <p className="text-fg-secondary text-zinc-400 dark:text-zinc-600" />;\n`,
      );
      expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe(
        `export const B = "p-2";\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
