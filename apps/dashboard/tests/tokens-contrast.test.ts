// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Guards the semantic token layer (src/app/tokens.css): the values must match
 * the design spec exactly, and every text/surface pair must keep its WCAG 2.x
 * contrast. A "tweak" to one hex that breaks AA fails here, not in review.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(HERE, "../src/app/tokens.css"), "utf8");

const LIGHT = {
  canvas: "#ffffff",
  sunken: "#fafafa",
  raised: "#ffffff",
  overlay: "#ffffff",
  hover: "#f4f4f5",
  "overlay-hover": "#f4f4f5",
  edge: "#e4e4e7",
  "edge-subtle": "#f0f0f2",
  "edge-strong": "#d4d4d8",
  fg: "#09090b",
  "fg-secondary": "#52525b",
  "fg-muted": "#6a6a73",
  brand: "#a8ff53",
  "brand-fg": "#000000",
  "brand-text": "#3f6212",
  ring: "#4d7c0f",
  "status-passed": "#16a34a",
  "status-passed-text": "#166534",
  "status-unresolved": "#f59e0b",
  "status-unresolved-text": "#92400e",
  "status-failed": "#ef4444",
  "status-failed-text": "#b91c1c",
  "status-running": "#3b82f6",
  "status-running-text": "#1d4ed8",
  "status-aborted": "#eab308",
  "status-aborted-text": "#854d0e",
  "status-neutral": "#71717a",
  "status-neutral-text": "#52525b",
} as const;

const DARK = {
  canvas: "#0b0b0d",
  sunken: "#08080a",
  raised: "#131316",
  overlay: "#1a1a1e",
  hover: "#1d1d21",
  "overlay-hover": "#24242a",
  edge: "#26262b",
  "edge-subtle": "#1b1b1f",
  "edge-strong": "#3a3a41",
  fg: "#fafafa",
  "fg-secondary": "#a1a1aa",
  "fg-muted": "#8b8b94",
  brand: "#a8ff53",
  "brand-fg": "#000000",
  "brand-text": "#a8ff53",
  ring: "#a8ff53",
  "status-passed": "#22c55e",
  "status-passed-text": "#4ade80",
  "status-unresolved": "#f59e0b",
  "status-unresolved-text": "#fbbf24",
  "status-failed": "#ef4444",
  "status-failed-text": "#f87171",
  "status-running": "#3b82f6",
  "status-running-text": "#60a5fa",
  "status-aborted": "#eab308",
  "status-aborted-text": "#facc15",
  "status-neutral": "#a1a1aa",
  "status-neutral-text": "#d4d4d8",
} as const;

const SURFACES = [
  "canvas",
  "sunken",
  "raised",
  "overlay",
  "hover",
  "overlay-hover",
];
const STATUSES = [
  "passed",
  "unresolved",
  "failed",
  "running",
  "aborted",
  "neutral",
];

/** Body of the single top-level `selector { … }` block in tokens.css. */
function blockBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`^${escaped}\\s*\\{`, "gm");
  const matches = [...css.matchAll(opener)];
  expect(
    matches,
    `${selector} must appear exactly once in tokens.css`,
  ).toHaveLength(1);
  const start = (matches[0]!.index ?? 0) + matches[0]![0].length;
  const end = css.indexOf("}", start);
  expect(end, `${selector} block must be closed`).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** `--name: #rrggbb;` declarations in a block (other value shapes are ignored). */
function parseHex(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

const parsed: Record<"light" | "dark", Record<string, string>> = {
  light: parseHex(blockBody(":root")),
  dark: parseHex(blockBody(".dark")),
};

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** `solid` at `p` opacity over `surface`, per-channel rounded, as #rrggbb. */
function mix(solid: string, surface: string, p: number): string {
  const s = channels(solid);
  const b = channels(surface);
  const m = s.map((c, i) => Math.round(c * p + b[i]! * (1 - p)));
  return `#${m.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const THEMES = [
  ["light", LIGHT],
  ["dark", DARK],
] as const;

describe("design tokens", () => {
  test.each(THEMES)("%s token values match the spec", (theme, want) => {
    expect(parsed[theme]).toMatchObject(want);
  });

  test.each(THEMES)(
    "%s: every fg tier and brand-text >= 4.5:1 on every surface",
    (theme) => {
      const t = parsed[theme];
      for (const fg of ["fg", "fg-secondary", "fg-muted", "brand-text"]) {
        for (const s of SURFACES) {
          expect(
            contrast(t[fg]!, t[s]!),
            `${fg} on ${s}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  test.each(THEMES)("%s: ring >= 3:1 on every surface", (theme) => {
    const t = parsed[theme];
    for (const s of SURFACES) {
      expect(contrast(t.ring!, t[s]!), `ring on ${s}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  test.each(THEMES)(
    "%s: status text >= 4.5:1 on its own 10% tint over raised/hover/sunken",
    (theme) => {
      const t = parsed[theme];
      for (const st of STATUSES) {
        for (const s of ["raised", "hover", "sunken"]) {
          const tint = mix(t[`status-${st}`]!, t[s]!, 0.1);
          expect(
            contrast(t[`status-${st}-text`]!, tint),
            `status-${st}-text on ${st} tint over ${s}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  // components/ui/switch.tsx: white thumb on an fg-muted track (unchecked),
  // brand-fg thumb on a brand track (checked). Non-text UI parts: >= 3:1
  // (WCAG 1.4.11), and the track itself must stand off every surface it sits on.
  test.each(THEMES)("%s: Switch track and thumb >= 3:1", (theme) => {
    const t = parsed[theme];
    expect(
      contrast("#ffffff", t["fg-muted"]!),
      "white thumb on fg-muted track",
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(t["brand-fg"]!, t.brand!),
      "brand-fg thumb on brand track",
    ).toBeGreaterThanOrEqual(3);
    for (const s of ["canvas", "raised", "overlay"]) {
      expect(
        contrast(t["fg-muted"]!, t[s]!),
        `fg-muted track on ${s}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test("@theme inline maps every token to a --color-* utility", () => {
    for (const k of Object.keys(LIGHT)) {
      expect(css).toContain(`--color-${k}: var(--${k})`);
    }
  });
});
