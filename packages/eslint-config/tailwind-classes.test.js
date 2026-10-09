import { describe, expect, test } from "vitest";

import {
  COLOR_PROPERTIES,
  NEUTRAL_PALETTES,
  isArbitraryColor,
  isArbitraryFontSize,
  isNeutral,
  parseClass,
  splitClasses,
} from "./tailwind-classes.js";

describe("splitClasses", () => {
  test("splits on any whitespace and drops empties", () => {
    expect(splitClasses("  a  b\tc\n d ")).toEqual(["a", "b", "c", "d"]);
    expect(splitClasses("")).toEqual([]);
    expect(splitClasses("   ")).toEqual([]);
  });
});

describe("constants", () => {
  test("NEUTRAL_PALETTES", () => {
    expect([...NEUTRAL_PALETTES]).toEqual([
      "zinc",
      "gray",
      "slate",
      "neutral",
      "stone",
    ]);
  });

  test("COLOR_PROPERTIES holds every colour-bearing utility prefix", () => {
    expect([...COLOR_PROPERTIES].sort()).toEqual(
      [
        "border-x",
        "border-y",
        "border-t",
        "border-r",
        "border-b",
        "border-l",
        "ring-offset",
        "decoration",
        "outline",
        "divide",
        "stroke",
        "shadow",
        "caret",
        "accent",
        "border",
        "ring",
        "fill",
        "from",
        "via",
        "bg",
        "text",
        "to",
      ].sort(),
    );
  });
});

describe("parseClass", () => {
  test("parses variants, property, palette value and opacity", () => {
    const p = parseClass("dark:hover:bg-zinc-900/50");
    expect(p).toMatchObject({
      raw: "dark:hover:bg-zinc-900/50",
      variants: ["dark", "hover"],
      property: "bg",
      value: "zinc-900",
      opacity: "50",
      important: false,
    });
  });

  test("keeps variant order", () => {
    expect(parseClass("hover:dark:text-white")?.variants).toEqual([
      "hover",
      "dark",
    ]);
  });

  test("does not split variants on a colon inside brackets", () => {
    expect(parseClass("data-[state=open]:bg-zinc-100")?.variants).toEqual([
      "data-[state=open]",
    ]);
    expect(parseClass("[&:hover]:bg-zinc-100")?.variants).toEqual([
      "[&:hover]",
    ]);
  });

  test("matches the longest property first", () => {
    expect(parseClass("border-l-zinc-300")?.property).toBe("border-l");
    expect(parseClass("border-zinc-300")?.property).toBe("border");
    expect(parseClass("focus-visible:ring-offset-white")?.property).toBe(
      "ring-offset",
    );
    expect(parseClass("ring-zinc-300")?.property).toBe("ring");
  });

  test("placeholder: is a variant, not a property", () => {
    const p = parseClass("placeholder:text-zinc-400");
    expect(p?.variants).toEqual(["placeholder"]);
    expect(p?.property).toBe("text");
    expect(p?.value).toBe("zinc-400");
  });

  test("splits opacity off token values", () => {
    const p = parseClass("bg-status-failed/10");
    expect(p?.value).toBe("status-failed");
    expect(p?.opacity).toBe("10");
  });

  test("opacity is null when absent", () => {
    expect(parseClass("bg-canvas")?.opacity).toBeNull();
  });

  test("an empty trailing slash does not become an opacity", () => {
    const p = parseClass("bg-status-failed/");
    expect(p?.value).toBe("status-failed");
    expect(p?.opacity).toBeNull();
  });

  test("strips important from either end", () => {
    const lead = parseClass("hover:!bg-zinc-100");
    expect(lead).toMatchObject({
      variants: ["hover"],
      property: "bg",
      value: "zinc-100",
      important: true,
    });
    const trail = parseClass("bg-zinc-100!");
    expect(trail).toMatchObject({
      property: "bg",
      value: "zinc-100",
      important: true,
    });
  });

  test("recognises all 22 palette names and shades", () => {
    const names = [
      "slate",
      "gray",
      "zinc",
      "neutral",
      "stone",
      "red",
      "orange",
      "amber",
      "yellow",
      "lime",
      "green",
      "emerald",
      "teal",
      "cyan",
      "sky",
      "blue",
      "indigo",
      "violet",
      "purple",
      "fuchsia",
      "pink",
      "rose",
    ];
    const shades = [
      "50",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
      "950",
    ];
    for (const n of names) {
      for (const s of shades) {
        expect(parseClass(`bg-${n}-${s}`)?.value).toBe(`${n}-${s}`);
      }
    }
    expect(parseClass("bg-zinc-150")).toBeNull();
    expect(parseClass("bg-zinc-1000")).toBeNull();
    expect(parseClass("bg-zinc")).toBeNull();
    expect(parseClass("bg-mauve-500")).toBeNull();
  });

  test("recognises colour keywords", () => {
    for (const k of ["white", "black", "transparent", "current", "inherit"]) {
      expect(parseClass(`text-${k}`)?.value).toBe(k);
    }
  });

  test("recognises semantic token names", () => {
    const tokens = [
      "canvas",
      "sunken",
      "raised",
      "overlay",
      "hover",
      "overlay-hover",
      "edge",
      "edge-subtle",
      "edge-strong",
      "fg",
      "fg-secondary",
      "fg-muted",
      "brand",
      "brand-fg",
      "brand-text",
      "ring",
      "status-passed",
      "status-passed-text",
      "status-unresolved",
      "status-unresolved-text",
      "status-failed",
      "status-failed-text",
      "status-running",
      "status-running-text",
      "status-aborted",
      "status-aborted-text",
      "status-neutral",
      "status-neutral-text",
    ];
    for (const t of tokens) {
      expect(parseClass(`bg-${t}`)?.value).toBe(t);
      expect(parseClass(`text-${t}/40`)).toMatchObject({
        value: t,
        opacity: "40",
      });
    }
  });

  test("recognises the shadcn-style alias names", () => {
    const aliases = [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
      "destructive",
      "destructive-foreground",
      "border",
      "input",
      "ring",
    ];
    for (const a of aliases) {
      expect(parseClass(`bg-${a}`)?.value).toBe(a);
    }
    expect(parseClass("border-border")).toMatchObject({
      property: "border",
      value: "border",
    });
  });

  test("an arbitrary colour keeps its raw bracket text as the value", () => {
    expect(parseClass("bg-[#09090b]")).toMatchObject({
      property: "bg",
      value: "[#09090b]",
      opacity: null,
    });
    expect(parseClass("dark:bg-[#050505]")).toMatchObject({
      variants: ["dark"],
      value: "[#050505]",
    });
  });

  test("opacity is only parsed from a trailing /NN outside brackets", () => {
    expect(parseClass("bg-[#a8ff53]/10")).toMatchObject({
      value: "[#a8ff53]",
      opacity: "10",
    });
    expect(parseClass("bg-[rgb(1_2_3/0.5)]")).toMatchObject({
      value: "[rgb(1_2_3/0.5)]",
      opacity: null,
    });
  });

  test("covers every colour property", () => {
    for (const prop of COLOR_PROPERTIES) {
      expect(parseClass(`${prop}-zinc-500`)).toMatchObject({
        property: prop,
        value: "zinc-500",
      });
    }
  });

  test.each([
    "text-sm",
    "border-2",
    "ring-offset-2",
    "bg-gradient-to-r",
    "dark:opacity-50",
    "shadow-lg",
    "text-left",
    "shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)]",
  ])("returns null for the non-colour class %s", (token) => {
    expect(parseClass(token)).toBeNull();
  });

  test.each([
    "outline-none",
    "divide-y",
    "stroke-2",
    "text-[11px]",
    "w-[12px]",
    "flex",
    "",
    "bg",
  ])("returns null for the unrelated token %j", (token) => {
    expect(parseClass(token)).toBeNull();
  });

  test("does not treat a shadow arbitrary value as a colour", () => {
    expect(parseClass("shadow-[#fff]")).toBeNull();
  });
});

describe("isNeutral", () => {
  test("true for neutral palette values", () => {
    for (const n of ["zinc", "gray", "slate", "neutral", "stone"]) {
      expect(isNeutral(parseClass(`bg-${n}-500`))).toBe(true);
    }
    expect(isNeutral(parseClass("bg-zinc-50"))).toBe(true);
    expect(isNeutral(parseClass("bg-zinc-950"))).toBe(true);
  });

  test("false for chromatic palettes, keywords, tokens and arbitrary values", () => {
    expect(isNeutral(parseClass("bg-red-500"))).toBe(false);
    expect(isNeutral(parseClass("bg-lime-400"))).toBe(false);
    expect(isNeutral(parseClass("bg-white"))).toBe(false);
    expect(isNeutral(parseClass("bg-canvas"))).toBe(false);
    expect(isNeutral(parseClass("bg-[#09090b]"))).toBe(false);
  });
});

describe("isArbitraryColor", () => {
  test.each([
    "bg-[#09090b]",
    "text-[rgb(1,2,3)]",
    "border-[rgba(1,2,3,0.5)]",
    "fill-[hsl(10,10%,10%)]",
    "ring-[hsla(10,10%,10%,0.5)]",
    "from-[oklch(0.7_0.1_120)]",
    "dark:data-[highlighted]:bg-[#a8ff53]/10",
    "hover:!text-[#5a8a2a]",
  ])("true for %s", (token) => {
    expect(isArbitraryColor(token)).toBe(true);
  });

  test.each([
    "shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)]",
    "shadow-[#000]",
    "w-[12px]",
    "text-[11px]",
    "bg-zinc-900",
    "bg-canvas",
    "bg-[var(--x)]",
    "flex",
  ])("false for %s", (token) => {
    expect(isArbitraryColor(token)).toBe(false);
  });
});

describe("isArbitraryFontSize", () => {
  test.each([
    "text-[11px]",
    "text-[0.7rem]",
    "text-[1.25em]",
    "md:text-[13px]",
    "text-[11px]!",
  ])("true for %s", (token) => {
    expect(isArbitraryFontSize(token)).toBe(true);
  });

  test.each([
    "text-[#fff]",
    "text-xs",
    "text-[length:var(--x)]",
    "w-[12px]",
    "text-[11%]",
    "text-zinc-500",
  ])("false for %s", (token) => {
    expect(isArbitraryFontSize(token)).toBe(false);
  });
});
