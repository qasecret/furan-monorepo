import type { DB, SQL } from "@furan/db";

/**
 * A statement a request issued, as `capturing` records it: the `SQL` of an
 * `execute`; `"select"` for a query-builder select (`select`,
 * `selectDistinct`, `selectDistinctOn`); `"query"` for a relational read
 * (`db.query.<table>.findFirst` / `findMany`), each by its name only.
 */
export type CapturedStatement = SQL | "select" | "query";

/**
 * `db.query` with every relational read through it recorded: each method
 * call on a table (`findFirst`, `findMany`) is one statement.
 */
function capturingQueries<Q extends object>(
  query: Q,
  into: CapturedStatement[],
): Q {
  return new Proxy(query, {
    get(target, table, receiver) {
      const builder = Reflect.get(target, table, receiver) as unknown;
      if (builder === null || typeof builder !== "object") return builder;
      return new Proxy(builder, {
        get(b, method, r) {
          const value = Reflect.get(b, method, r) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            into.push("query");
            return (value as (...a: unknown[]) => unknown).apply(b, args);
          };
        },
      });
    },
  });
}

/**
 * `db` with every statement `execute`d, `select`ed or read through
 * `db.query` on it, or on a transaction it opens, recorded in `into`. A tRPC
 * request runs its body in the transaction `scopeToUser` opens on `ctx.db`,
 * so a proxy that does not follow `transaction` sees none of the body's
 * statements.
 */
export function capturing(db: DB, into: CapturedStatement[]): DB {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "query" && value !== null && typeof value === "object") {
        return capturingQueries(value, into);
      }
      if (typeof value !== "function") return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (prop === "transaction") {
        return (cb: (tx: DB) => unknown, ...rest: unknown[]) =>
          fn.call(target, (tx: DB) => cb(capturing(tx, into)), ...rest);
      }
      if (prop === "execute") {
        return (q: SQL) => {
          into.push(q);
          return fn.call(target, q);
        };
      }
      if (
        prop === "select" ||
        prop === "selectDistinct" ||
        prop === "selectDistinctOn"
      ) {
        return (...args: unknown[]) => {
          into.push("select");
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
}

/** The request scope's own `set_config` statement (`withUserScope`). */
export function isScopeStatement(q: CapturedStatement): boolean {
  if (typeof q === "string") return false;
  return q.queryChunks.some(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      "value" in c &&
      Array.isArray(c.value) &&
      c.value.some((v) => typeof v === "string" && v.includes("set_config")),
  );
}

/** The statements of a request body: `into` without the scope's own. */
export function bodyStatements(
  into: readonly CapturedStatement[],
): CapturedStatement[] {
  return into.filter((q) => !isScopeStatement(q));
}
