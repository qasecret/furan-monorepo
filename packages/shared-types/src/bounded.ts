import { z } from "zod";

/**
 * Size-gated collections for request inputs (CVE-2023-54404).
 *
 * zod 3's `.max(n)` records `too_big` and then still parses every element, so
 * an array of a million bad elements costs a million issues (seconds of CPU,
 * hundreds of MB of heap) before the request is rejected. tRPC parses input
 * before `authed` runs, so that cost is open to anonymous callers. zod 4.6.6
 * checks the size first, but only for constrained arrays, and 3.x has no fix.
 *
 * These helpers check the size first: an oversized collection fails with one
 * fatal issue and none of its elements are parsed (a fatal issue raised in
 * `z.preprocess` aborts before the inner schema runs). Every array or record
 * a caller sends goes through one of them, never a bare `z.array` /
 * `z.record`.
 */

/**
 * `z.array(element)` with `min`/`max`, where an array longer than `max` is
 * rejected before any element is parsed. A non-array falls through to
 * `z.array`'s own `invalid_type` issue. The issue for an oversized array is
 * the one `.max(max)` raises, so callers see the same error as before.
 */
export function boundedArray<T extends z.ZodTypeAny>(
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
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: max,
        inclusive: true,
        exact: false,
        message: `Array must contain at most ${max} element(s)`,
        fatal: true,
      });
    }
    return value;
  }, array) as unknown as z.ZodEffects<
    typeof array,
    z.output<typeof array>,
    z.input<typeof array>
  >;
}

/**
 * `z.record(key, value)` where an object with more than `maxKeys` own keys is
 * rejected before any key or value is parsed. A non-object falls through to
 * `z.record`'s own `invalid_type` issue.
 */
export function boundedRecord<K extends z.KeySchema, V extends z.ZodTypeAny>(
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, fatal: true });
    }
    return input;
  }, record) as unknown as z.ZodEffects<
    typeof record,
    z.output<typeof record>,
    z.input<typeof record>
  >;
}
