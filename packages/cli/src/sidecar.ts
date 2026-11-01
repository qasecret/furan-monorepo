import { promises as fsp } from "node:fs";

import {
  FuranInputError,
  MATCH_LEVELS,
  MAX_REGIONS_PER_KIND,
  type Box,
  type FloatingBox,
  type MatchLevel,
} from "@furan/client";

/** Per-step options from `<stem>.furan.json` next to `<stem>.png`. */
export interface SidecarOptions {
  matchLevel?: MatchLevel;
  ignore?: Box[];
  layout?: Box[];
  content?: Box[];
  floating?: FloatingBox[];
}

const KEYS = new Set(["matchLevel", "ignore", "layout", "content", "floating"]);
const BOX_KEYS = ["x", "y", "width", "height"] as const;
const FLOATING_KEYS = [
  "maxUpOffset",
  "maxDownOffset",
  "maxLeftOffset",
  "maxRightOffset",
] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a sidecar's JSON strictly; every problem names `file`. */
export function parseSidecar(json: unknown, file: string): SidecarOptions {
  const fail = (msg: string): never => {
    throw new FuranInputError(msg, file);
  };
  if (!isObject(json)) fail("must be a JSON object");
  const obj = json as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key)) {
      fail(`unknown key "${key}" (allowed: ${[...KEYS].join(", ")})`);
    }
  }
  const out: SidecarOptions = {};
  if (obj.matchLevel !== undefined) {
    if (!MATCH_LEVELS.includes(obj.matchLevel as MatchLevel)) {
      fail(`matchLevel must be one of ${MATCH_LEVELS.join(", ")}`);
    }
    out.matchLevel = obj.matchLevel as MatchLevel;
  }

  const boxes = (kind: string, extra: readonly string[]): FloatingBox[] => {
    const list = obj[kind];
    if (!Array.isArray(list)) fail(`${kind} must be an array of boxes`);
    const arr = list as unknown[];
    if (arr.length > MAX_REGIONS_PER_KIND) {
      fail(`at most ${MAX_REGIONS_PER_KIND} ${kind} boxes (got ${arr.length})`);
    }
    return arr.map((b, i) => {
      if (!isObject(b)) return fail(`${kind}[${i}] must be an object`);
      const allowed = new Set<string>([...BOX_KEYS, ...extra]);
      for (const key of Object.keys(b)) {
        if (!allowed.has(key)) fail(`${kind}[${i}] has unknown key "${key}"`);
      }
      const out: Record<string, number> = {};
      for (const key of [...BOX_KEYS, ...extra]) {
        const value = b[key];
        if (value === undefined && !BOX_KEYS.includes(key as never)) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail(`${kind}[${i}].${key} must be a number`);
        }
        out[key] = value as number;
      }
      return out as unknown as FloatingBox;
    });
  };

  if (obj.ignore !== undefined) out.ignore = boxes("ignore", []);
  if (obj.layout !== undefined) out.layout = boxes("layout", []);
  if (obj.content !== undefined) out.content = boxes("content", []);
  if (obj.floating !== undefined)
    out.floating = boxes("floating", FLOATING_KEYS);
  return out;
}

/** The sidecar path for a PNG: `a/home.png` → `a/home.furan.json`. */
export const sidecarPath = (pngPath: string): string =>
  pngPath.replace(/\.png$/i, "") + ".furan.json";

/** Read and validate the sidecar next to `pngPath`; null when there is none. */
export async function readSidecar(
  pngPath: string,
): Promise<SidecarOptions | null> {
  const path = sidecarPath(pngPath);
  let text: string;
  try {
    text = await fsp.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FuranInputError(
      `cannot be read: ${(err as Error).message}`,
      path,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FuranInputError("is not valid JSON", path);
  }
  return parseSidecar(json, path);
}
