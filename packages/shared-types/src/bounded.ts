import { z } from "zod";

/**
 * Size-gated collections for request inputs (CVE-2023-54404).
 *
 * Before zod 4.6.6, `.max(n)` recorded `too_big` and then still parsed every
 * element, so an array of a million bad elements cost a million issues
 * (seconds of CPU, hundreds of MB of heap) before the request was rejected.
 * tRPC parses input before `authed` runs, so that cost is open to anonymous
 * callers. zod 4.6.6+ checks the size first, but only for arrays, sets and
 * maps that declare a size check: a record, or an array without `.max()`,
 * is still parsed in full.
 *
 * These helpers check the size first: an oversized collection fails with one
 * issue and none of its elements are parsed (any issue raised in
 * `z.preprocess` stops the pipe before the inner schema runs). Every array or
 * record a caller sends goes through one of them, never a bare `z.array` /
 * `z.record`.
 */

/**
 * `z.array(element)` with `min`/`max`, where an array longer than `max` is
 * rejected before any element is parsed. A non-array falls through to
 * `z.array`'s own `invalid_type` issue. The issue for an oversized array is
 * the one `.max(max)` raises, so callers see the same error as before.
 */
export function boundedArray<T extends z.ZodType>(
  element: T,
  max: number,
  { min }: { min?: number } = {},
) {
  const array =
    min === undefined
      ? z.array(element).max(max)
      : z.array(element).min(min).max(max);
  // preprocess types its input as `unknown`; the cast keeps the array's input
  // type so tRPC clients still see `string[]` (not `unknown`) for these fields.
  return z.preprocess((value, ctx) => {
    if (Array.isArray(value) && value.length > max) {
      // No message: zod renders the one `.max(max)` would.
      ctx.addIssue({
        code: "too_big",
        origin: "array",
        maximum: max,
        inclusive: true,
        input: value,
      });
    }
    return value;
  }, array) as unknown as z.ZodPreprocess<typeof array, z.input<typeof array>>;
}

/**
 * `z.record(key, value)` where an object with more than `maxKeys` own keys is
 * rejected before any key or value is parsed. A non-object falls through to
 * `z.record`'s own `invalid_type` issue.
 */
export function boundedRecord<
  K extends z.core.$ZodRecordKey,
  V extends z.ZodType,
>(
  key: K,
  value: V,
  maxKeys: number,
  message = `Object must contain at most ${maxKeys} key(s)`,
) {
  const record = z.record(key, value);
  return z.preprocess((input, ctx) => {
    if (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).length > maxKeys
    ) {
      ctx.addIssue({ code: "custom", message, input });
    }
    return input;
  }, record) as unknown as z.ZodPreprocess<
    typeof record,
    z.input<typeof record>
  >;
}
