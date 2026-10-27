/** A Postgres error's SQLSTATE, wherever the driver or Drizzle put it. */
export function pgCode(err: unknown): string | undefined {
  let e = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
