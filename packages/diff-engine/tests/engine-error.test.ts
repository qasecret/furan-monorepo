import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runDiff } from "../src/engine.js";
import { DiffEngineError } from "../src/errors.js";
import { runL1 } from "../src/l1.js";
import {
  DEFAULT_ENGINE_CONFIG,
  type ImageComparison,
  type ProjectDiffConfig,
} from "../src/types.js";
import { runVlm } from "../src/vlm/index.js";
import type { VlmProvider } from "../src/vlm/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

/** Bytes no PNG decoder accepts. */
const GARBAGE = Buffer.from("this is not a png");

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

describe("DiffEngineError", () => {
  it("records the stage and the original error as its cause", () => {
    const cause = new Error("boom");
    const err = new DiffEngineError("engine", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DiffEngineError");
    expect(err.stage).toBe("engine");
    expect(err.cause).toBe(cause);
    // The message keeps the original's, so logs and message matchers still see it.
    expect(err.message).toContain("boom");
  });

  it("accepts a thrown non-Error", () => {
    const err = new DiffEngineError("vlm", "just a string");
    expect(err.stage).toBe("vlm");
    expect(err.cause).toBe("just a string");
    expect(err.message).toContain("just a string");
  });
});

describe("the pixel engine tags what it throws", () => {
  it("runL1 wraps an unknown engine", async () => {
    const err = await caught(
      runL1(
        FIXTURE("baseline-a.png"),
        FIXTURE("candidate-a-identical.png"),
        undefined,
        "nope" as unknown as ImageComparison,
        DEFAULT_ENGINE_CONFIG,
      ),
    );
    expect(err).toBeInstanceOf(DiffEngineError);
    expect((err as DiffEngineError).stage).toBe("engine");
    expect(((err as DiffEngineError).cause as Error).message).toMatch(
      /Unknown image comparison engine/,
    );
  });

  it.each<ImageComparison>(["pixelmatch", "looks_same"])(
    "runL1 wraps a PNG decode failure in %s",
    async (engine) => {
      const err = await caught(
        runL1(GARBAGE, GARBAGE, undefined, engine, DEFAULT_ENGINE_CONFIG),
      );
      expect(err).toBeInstanceOf(DiffEngineError);
      expect((err as DiffEngineError).stage).toBe("engine");
      expect((err as DiffEngineError).cause).toBeInstanceOf(Error);
    },
  );

  it("runDiff lets the engine's tagged error through", async () => {
    const config: ProjectDiffConfig = {
      diffThreshold: 0.001,
      engine: "pixelmatch",
      engineConfig: DEFAULT_ENGINE_CONFIG,
    };
    const err = await caught(
      runDiff({
        baseline: { image: GARBAGE },
        candidate: { image: GARBAGE },
        config,
      }),
    );
    expect(err).toBeInstanceOf(DiffEngineError);
    expect((err as DiffEngineError).stage).toBe("engine");
  });

  it("runL1 does not tag a successful compare", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      "pixelmatch",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });
});

describe("runVlm", () => {
  const provider: VlmProvider = {
    generate: async () => ({ content: "{}" }),
  };
  const options = {
    provider,
    config: {
      provider: "ollama" as const,
      model: "test",
      prompt: "test",
      temperature: 0,
    },
    engineConfig: DEFAULT_ENGINE_CONFIG,
    diffThreshold: 0.001,
  };

  it("tags a failure of its own pixel compare as an engine failure", async () => {
    const err = await caught(runVlm(GARBAGE, GARBAGE, options));
    expect(err).toBeInstanceOf(DiffEngineError);
    expect((err as DiffEngineError).stage).toBe("engine");
  });

  it("still folds a provider failure into the L1 fallback, not a throw", async () => {
    const failing: VlmProvider = {
      generate: async () => {
        throw new Error("provider down");
      },
    };
    const result = await runVlm(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      { ...options, provider: failing },
    );
    expect(result.vlmError?.reason).toBe("call_failed");
  });
});
