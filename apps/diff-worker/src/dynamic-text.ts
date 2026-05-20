import type { Telemetry } from "@furan/telemetry";
import sharp from "sharp";

import type { ParsedIgnoreArea } from "./handler.js";

type Logger = Telemetry["logger"];

/** Hard cap on dynamic-text regions evaluated per diff. Above this, the
 * overflow is logged and treated as unmatched (defensive: fall through
 * to L1 catching real visual diffs rather than silently suppressing). */
const MAX_DYNAMIC_REGIONS = 10;

interface TesseractWorkerLike {
  recognize: (img: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
}

/** Lazy-initialized tesseract worker; one per diff-worker process. */
let tesseractWorkerPromise: Promise<TesseractWorkerLike> | null = null;

/** For tests: clear the lazy singleton so per-test mock injection works. */
export function __resetTesseractWorkerForTests(): void {
  tesseractWorkerPromise = null;
}

async function getTesseractWorker(): Promise<TesseractWorkerLike> {
  if (tesseractWorkerPromise) return tesseractWorkerPromise;
  tesseractWorkerPromise = (async () => {
    const { createWorker } = await import("tesseract.js");
    return (await createWorker("eng")) as unknown as TesseractWorkerLike;
  })();
  return tesseractWorkerPromise;
}

export interface DynamicTextResult {
  /** Index of the region in the `allRegions` array passed in.
   * Stable across the call chain so the handler can correlate the result
   * back to the source region for filter + audit insertion. */
  regionIndex: number;
  /** Extracted text (trimmed), or null if OCR failed for this region. */
  ocrText: string | null;
  /** Whether ocrText matched the region's regex. False on empty text or
   * invalid pattern. */
  matched: boolean;
}

/**
 * Crops the candidate image to each dynamic-text region, OCRs the crop,
 * evaluates the region's regex against the extracted text. Results carry
 * `regionIndex` into the input array.
 *
 * Caps at MAX_DYNAMIC_REGIONS — overage is logged + treated as unmatched.
 * On tesseract init failure, every dynamic-text region is treated as
 * unmatched. Per-region errors (sharp.extract failure, invalid regex)
 * are logged but don't break the batch.
 */
export async function evaluateDynamicTextRegions(
  candidateBytes: Buffer,
  allRegions: ParsedIgnoreArea[],
  logger: Logger,
): Promise<DynamicTextResult[]> {
  const dynamicIndexes: number[] = [];
  for (let i = 0; i < allRegions.length; i++) {
    const r = allRegions[i]!;
    if (r.kind === "dynamic-text" && r.pattern) dynamicIndexes.push(i);
  }
  if (dynamicIndexes.length === 0) return [];
  if (dynamicIndexes.length > MAX_DYNAMIC_REGIONS) {
    logger.warn(
      { present: dynamicIndexes.length, cap: MAX_DYNAMIC_REGIONS },
      "dynamic_text_regions_capped",
    );
  }
  const capped = dynamicIndexes.slice(0, MAX_DYNAMIC_REGIONS);

  let worker: TesseractWorkerLike;
  try {
    worker = await getTesseractWorker();
  } catch (err) {
    logger.error({ err }, "tesseract_init_failed");
    // Important: reset the failed promise so a future call can retry.
    tesseractWorkerPromise = null;
    return capped.map((regionIndex) => ({
      regionIndex,
      ocrText: null,
      matched: false,
    }));
  }

  const results: DynamicTextResult[] = [];
  for (const regionIndex of capped) {
    const r = allRegions[regionIndex]!;
    try {
      const crop = await sharp(candidateBytes)
        .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
        .png()
        .toBuffer();
      const ocr = await worker.recognize(crop);
      const text = ocr.data.text.trim();
      let matched = false;
      if (text.length > 0 && r.pattern) {
        try {
          matched = new RegExp(r.pattern, "i").test(text);
        } catch (err) {
          logger.warn(
            { regionIndex, pattern: r.pattern, err },
            "dynamic_text_regex_invalid",
          );
        }
      }
      results.push({ regionIndex, ocrText: text, matched });
    } catch (err) {
      logger.warn({ regionIndex, err }, "dynamic_text_ocr_failed");
      results.push({ regionIndex, ocrText: null, matched: false });
    }
  }
  return results;
}
