import { createHash } from "node:crypto";

import { DiffDOM, stringToObj } from "diff-dom";

import type { DiffRegion, RegionCategory } from "./types.js";

interface DdOp {
  action: string;
  oldValue?: string;
  newValue?: string;
  name?: string;
  route?: number[];
  element?: { nodeName?: string };
}

function opToRegion(op: DdOp): DiffRegion | null {
  const id = createHash("sha256")
    .update(JSON.stringify(op))
    .digest("hex")
    .slice(0, 16);
  const baseBbox = { x: 0, y: 0, width: 0, height: 0 };
  switch (op.action) {
    case "modifyTextElement":
      return {
        id,
        severity: "minor",
        category: "text",
        bbox: baseBbox,
        source: "l2",
        description:
          `Text changed: "${(op.oldValue ?? "").slice(0, 60)}" -> "${(op.newValue ?? "").slice(0, 60)}"`.slice(
            0,
            200,
          ),
        ...(op.route ? { route: op.route } : {}),
      };
    case "addElement":
      return {
        id,
        severity: "major",
        category: "structural",
        bbox: baseBbox,
        source: "l2",
        description:
          `Element added: <${op.element?.nodeName?.toLowerCase() ?? "unknown"}>`.slice(
            0,
            200,
          ),
        ...(op.route ? { route: op.route } : {}),
      };
    case "removeElement":
      return {
        id,
        severity: "major",
        category: "structural",
        bbox: baseBbox,
        source: "l2",
        description:
          `Element removed: <${op.element?.nodeName?.toLowerCase() ?? "unknown"}>`.slice(
            0,
            200,
          ),
        ...(op.route ? { route: op.route } : {}),
      };
    case "modifyAttribute": {
      const oldV = op.oldValue ?? "";
      const newV = op.newValue ?? "";
      const looksLikeColor = /(#[0-9a-fA-F]{3,8}|rgb|hsl)/.test(oldV + newV);
      const category: RegionCategory = looksLikeColor
        ? "color"
        : op.name === "class" || op.name === "style"
          ? "layout"
          : "structural";
      return {
        id,
        severity: "minor",
        category,
        bbox: baseBbox,
        source: "l2",
        description: `Attribute "${op.name}" changed`.slice(0, 200),
        ...(op.route ? { route: op.route } : {}),
      };
    }
    case "relocateGroup":
      return {
        id,
        severity: "major",
        category: "layout",
        bbox: baseBbox,
        source: "l2",
        description: "Element relocated",
        ...(op.route ? { route: op.route } : {}),
      };
    default:
      return null;
  }
}

const dd = new DiffDOM();

export interface RunL2Options {
  /**
   * Tier 1.4 (Eyes-parity `ignoreDisplacements`): when true, drop
   * regions originating from diff-dom `relocateGroup` ops — same
   * content, new position. Defaults to false (today's behavior).
   *
   * Pixel-level (L1) displacement detection is a separate engine pass;
   * this flag only governs the DOM signal.
   */
  ignoreDisplacements?: boolean;
}

export async function runL2(
  baselineDom: string,
  candidateDom: string,
  options: RunL2Options = {},
): Promise<DiffRegion[]> {
  const blObj = stringToObj(baselineDom);
  const cdObj = stringToObj(candidateDom);
  const ops = dd.diff(blObj, cdObj) as unknown as DdOp[];
  const filtered = options.ignoreDisplacements
    ? ops.filter((op) => op.action !== "relocateGroup")
    : ops;
  const regions = filtered
    .map(opToRegion)
    .filter((r): r is DiffRegion => r !== null);
  if (regions.length > 200) {
    return [
      ...regions.slice(0, 199),
      {
        id: "overflow",
        severity: "minor",
        category: "structural",
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        source: "l2",
        description: `and ${regions.length - 199} more changes`,
      },
    ];
  }
  return regions;
}
