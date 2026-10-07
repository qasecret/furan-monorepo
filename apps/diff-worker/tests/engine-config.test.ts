import { DEFAULT_ENGINE_CONFIG } from "@furan/diff-engine";
import { describe, expect, it, vi } from "vitest";

import { parseEngineConfig, redactSecret } from "../src/engine-config.js";

// ADR-060: `projects.image_comparison_config` holds the pixel-engine knobs
// AND the Visual-AI provider config — including the provider API key. A
// parse failure must never put that blob (or the parser's message, which V8
// fills with a quote of the input) into the logs.

const KEY = "sk-live-LEAKCANARY-0123456789"; // gitleaks:allow — fake test key

function warnLogger() {
  const warn = vi.fn();
  return { logger: { warn }, warn };
}

const logged = (warn: ReturnType<typeof vi.fn>) =>
  JSON.stringify(warn.mock.calls);

describe("parseEngineConfig", () => {
  it("parses valid knobs and ignores the Visual-AI fields in the same blob", () => {
    const { logger, warn } = warnLogger();
    const cfg = parseEngineConfig(
      JSON.stringify({ threshold: 0.3, provider: "anthropic", apiKey: KEY }),
      logger,
      "p1",
    );
    expect(cfg.threshold).toBe(0.3);
    expect(cfg).not.toHaveProperty("apiKey");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns defaults for an empty config without warning", () => {
    const { logger, warn } = warnLogger();
    expect(parseEngineConfig("", logger, "p1")).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(parseEngineConfig(null, logger, "p1")).toEqual(
      DEFAULT_ENGINE_CONFIG,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "truncated JSON holding a key",
      `{"provider":"anthropic","apiKey":"${KEY}"`,
    ],
    ["a bare key (V8 quotes it in the SyntaxError)", KEY],
    ["a key followed by junk", `{"apiKey":"${KEY}" junk}`],
  ])("invalid JSON — %s — falls back and never logs the input", (_l, raw) => {
    const { logger, warn } = warnLogger();
    expect(parseEngineConfig(raw, logger, "p1")).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(warn).toHaveBeenCalledOnce();
    const [meta, msg] = warn.mock.calls[0]!;
    expect(msg).toBe(
      "image_comparison_config_invalid_falling_back_to_defaults",
    );
    expect(meta).toEqual({
      projectId: "p1",
      reason: "invalid_json",
      rawLength: raw.length,
    });
    expect(logged(warn)).not.toContain("LEAKCANARY");
  });

  it("schema mismatch logs issue paths + codes, never values", () => {
    const { logger, warn } = warnLogger();
    const raw = JSON.stringify({ threshold: KEY, apiKey: KEY });
    expect(parseEngineConfig(raw, logger, "p1")).toEqual(DEFAULT_ENGINE_CONFIG);
    const [meta] = warn.mock.calls[0]!;
    expect(meta).toEqual({
      projectId: "p1",
      reason: "schema_mismatch",
      rawLength: raw.length,
      issues: [{ path: "threshold", code: "invalid_type" }],
    });
    expect(logged(warn)).not.toContain("LEAKCANARY");
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence of the key", () => {
    expect(redactSecret(`bad key ${KEY}; retry with ${KEY}`, KEY)).toBe(
      "bad key [redacted]; retry with [redacted]",
    );
  });

  it("leaves text alone when there's no usable secret", () => {
    for (const secret of [undefined, null, "", "abc", 42]) {
      expect(redactSecret("VLM failed: 401", secret)).toBe("VLM failed: 401");
    }
  });

  it("handles regex metacharacters in the key literally", () => {
    const weird = "sk.+*?(x)[y]";
    expect(redactSecret(`k=${weird}`, weird)).toBe("k=[redacted]");
  });
});
