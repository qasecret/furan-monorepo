import { describe, expect, it } from "vitest";

import {
  describeConfigChange,
  isValidImageComparisonConfig,
  mergeImageComparisonConfig,
  providerSettingsChanged,
  redactImageComparisonConfig,
  toPublicProject,
} from "../src/lib/project-ai-config.js";

// ADR-060: Visual-AI credentials in `projects.image_comparison_config` are
// write-only; provider / baseUrl / apiKey changes are admin-only.

const KEY = "sk-live-SECRET-0123456789"; // gitleaks:allow — fake test key
const vlm = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      provider: "anthropic",
      model: "claude-x",
      temperature: 0.1,
      apiKey: KEY,
      ...extra,
    },
    null,
    2,
  );

describe("redactImageComparisonConfig", () => {
  it("strips apiKey and reports that one is configured", () => {
    const r = redactImageComparisonConfig(vlm());
    expect(r.hasApiKey).toBe(true);
    expect(r.config).not.toContain(KEY);
    expect(JSON.parse(r.config)).toEqual({
      provider: "anthropic",
      model: "claude-x",
      temperature: 0.1,
    });
  });

  it("returns configs without a key verbatim (formatting preserved)", () => {
    const raw = '{"threshold":0.1,"ignoreAntialiasing":true}';
    expect(redactImageComparisonConfig(raw)).toEqual({
      config: raw,
      hasApiKey: false,
    });
  });

  it("treats an empty-string apiKey as not configured (and strips it)", () => {
    const r = redactImageComparisonConfig(vlm({ apiKey: "" }));
    expect(r.hasApiKey).toBe(false);
    expect(JSON.parse(r.config)).not.toHaveProperty("apiKey");
  });

  it("handles empty / null stored values", () => {
    expect(redactImageComparisonConfig("")).toEqual({
      config: "",
      hasApiKey: false,
    });
    expect(redactImageComparisonConfig(null)).toEqual({
      config: "",
      hasApiKey: false,
    });
  });

  it("never echoes an unparseable stored blob (it may hold a key)", () => {
    const garbage = `{"apiKey":"${KEY}", oops`;
    const r = redactImageComparisonConfig(garbage);
    expect(r.config).toBe("");
    expect(r.config).not.toContain(KEY);
  });

  it("does not treat a non-object JSON value as a config", () => {
    expect(redactImageComparisonConfig(`["${KEY}"]`).config).toBe("");
  });
});

describe("toPublicProject", () => {
  it("redacts the config and adds hasVlmApiKey, leaving other fields alone", () => {
    const row = { id: "p1", name: "alpha", imageComparisonConfig: vlm() };
    const pub = toPublicProject(row);
    expect(pub.id).toBe("p1");
    expect(pub.name).toBe("alpha");
    expect(pub.hasVlmApiKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(KEY);
  });
});

describe("isValidImageComparisonConfig", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["object", '{"threshold":0.2}'],
  ])("accepts %s", (_l, v) => {
    expect(isValidImageComparisonConfig(v)).toBe(true);
  });
  it.each([
    ["not JSON", "{oops"],
    ["array", "[1,2]"],
    ["string", '"hi"'],
    ["number", "3"],
    ["null", "null"],
  ])("rejects %s", (_l, v) => {
    expect(isValidImageComparisonConfig(v)).toBe(false);
  });
});

describe("mergeImageComparisonConfig — write-only key semantics", () => {
  it("keeps the stored key when the incoming object omits apiKey (round-trip)", () => {
    const incoming = redactImageComparisonConfig(vlm()).config;
    const next = JSON.parse(
      mergeImageComparisonConfig(vlm(), incoming.replace("0.1", "0.3")),
    );
    expect(next.apiKey).toBe(KEY);
    expect(next.temperature).toBe(0.3);
  });

  it("replaces the key when a new non-empty apiKey is sent", () => {
    const next = JSON.parse(
      mergeImageComparisonConfig(vlm(), vlm({ apiKey: "sk-new" })),
    );
    expect(next.apiKey).toBe("sk-new");
  });

  it.each([
    ["empty string", ""],
    ["null", null],
  ])("clears the key when apiKey is %s", (_l, v) => {
    const next = JSON.parse(
      mergeImageComparisonConfig(vlm(), vlm({ apiKey: v })),
    );
    expect(next).not.toHaveProperty("apiKey");
  });

  it("an empty incoming config clears everything, key included", () => {
    expect(mergeImageComparisonConfig(vlm(), "")).toBe("");
  });

  it("stores the incoming string verbatim when nothing needs merging", () => {
    const raw = '{"threshold":0.25}';
    expect(mergeImageComparisonConfig('{"threshold":0.1}', raw)).toBe(raw);
  });

  it("tolerates an unparseable stored blob", () => {
    const raw = '{"threshold":0.25}';
    expect(mergeImageComparisonConfig("{oops", raw)).toBe(raw);
  });
});

describe("providerSettingsChanged — the admin-only subset", () => {
  it("is false for engine-knob / model / prompt edits", () => {
    expect(
      providerSettingsChanged(
        vlm(),
        vlm({ model: "other", prompt: "p", temperature: 0.9, threshold: 0.4 }),
      ),
    ).toBe(false);
  });

  it.each([
    ["provider", { provider: "gemini" }],
    ["baseUrl", { baseUrl: "http://evil.example:11434" }],
    ["apiKey", { apiKey: "sk-other" }],
  ])("is true when %s changes", (_l, extra) => {
    expect(providerSettingsChanged(vlm(), vlm(extra))).toBe(true);
  });

  it("is true when the key is cleared or the whole config is wiped", () => {
    expect(providerSettingsChanged(vlm(), vlm({ apiKey: undefined }))).toBe(
      true,
    );
    expect(providerSettingsChanged(vlm(), "")).toBe(true);
  });

  it("treats an absent provider as the default (ollama)", () => {
    expect(
      providerSettingsChanged(
        '{"model":"m"}',
        '{"model":"m","provider":"ollama"}',
      ),
    ).toBe(false);
    expect(
      providerSettingsChanged('{"model":"m"}', '{"provider":"gemini"}'),
    ).toBe(true);
  });

  it("is false between two configs that both lack provider settings", () => {
    expect(providerSettingsChanged("", '{"threshold":0.3}')).toBe(false);
    expect(providerSettingsChanged("{oops", "")).toBe(false);
  });
});

describe("describeConfigChange — audit metadata without secrets", () => {
  it("lists changed sub-keys and summarises the key without its value", () => {
    const d = describeConfigChange(
      vlm(),
      vlm({ apiKey: "sk-new", model: "m2" }),
    );
    expect(d.changedKeys).toEqual(["apiKey", "model"]);
    expect(d.apiKey).toBe("replaced");
    expect(JSON.stringify(d)).not.toContain(KEY);
    expect(JSON.stringify(d)).not.toContain("sk-new");
  });

  it.each([
    ["set", "{}", vlm()],
    ["cleared", vlm(), vlm({ apiKey: undefined })],
  ] as const)("reports apiKey %s", (expected, before, after) => {
    expect(describeConfigChange(before, after).apiKey).toBe(expected);
  });

  it("omits apiKey when the key did not change", () => {
    expect(describeConfigChange(vlm(), vlm({ model: "m2" })).apiKey).toBe(
      undefined,
    );
  });
});
