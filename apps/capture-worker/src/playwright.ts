import type { CaptureJob } from "@furan/queue";
import { chromium, firefox, webkit, type Browser } from "playwright";

const browsers: Partial<Record<CaptureJob["browser"], Browser>> = {};

/**
 * Lazily launches and caches a headless browser per engine. Reuse across jobs
 * amortises the ~1-2s cold-start. Call {@link closeAllBrowsers} on shutdown.
 */
export async function getBrowser(
  engine: CaptureJob["browser"],
): Promise<Browser> {
  const existing = browsers[engine];
  if (existing) return existing;
  const launcher = { chromium, firefox, webkit }[engine];
  const launched = await launcher.launch({ headless: true });
  browsers[engine] = launched;
  return launched;
}

export async function closeAllBrowsers(): Promise<void> {
  await Promise.all(Object.values(browsers).map((b) => b?.close()));
  for (const k of Object.keys(browsers)) {
    delete browsers[k as CaptureJob["browser"]];
  }
}
