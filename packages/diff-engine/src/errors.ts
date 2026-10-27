/** Which stage of a diff failed. */
export type DiffStage = "engine" | "vlm";

/**
 * A failure of the diff itself, tagged with the stage that threw it.
 *
 * The pixel engines (odiff, pixelmatch, looks-same) and the PNG decoders under
 * them throw plain `Error`s with nothing but a message to tell them apart, so
 * the stage is recorded where they are called: `runL1` and `runVlm`'s own pixel
 * compare tag `engine`; `vlm` marks the vision-model layer. The original error
 * stays as `cause` (and its message is kept in this one's), so a caller can
 * still look inside, e.g. for an unreadable PNG.
 */
export class DiffEngineError extends Error {
  override readonly name = "DiffEngineError";
  readonly stage: DiffStage;

  constructor(stage: DiffStage, cause: unknown) {
    super(
      `${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.stage = stage;
  }
}
