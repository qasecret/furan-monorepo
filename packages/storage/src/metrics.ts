import { Counter, type Registry } from "prom-client";

import type { Storage } from "./types.js";

/**
 * `furan_storage_operation_errors_total{operation,backend}` — a thrown error
 * from any Storage operation. A rising rate means object writes/reads are
 * failing (bucket auth, disk full, endpoint partition) — i.e. screenshots or
 * diff artifacts are silently being lost. `operation` + `backend` are small
 * closed sets, so label cardinality is safe.
 *
 * Registered once per Registry via a WeakMap so repeated `createStorage`
 * calls and test-isolated registries never double-register the series — the
 * same pattern the api's broadcast-metrics uses.
 */
type StorageOp = keyof Storage;
type Backend = "s3" | "hdd";

const byRegistry = new WeakMap<Registry, Counter<"operation" | "backend">>();

function errorCounter(registry: Registry): Counter<"operation" | "backend"> {
  const existing = byRegistry.get(registry);
  if (existing) return existing;
  const counter = new Counter({
    name: "furan_storage_operation_errors_total",
    help: "Storage backend operations that threw, by operation and backend",
    labelNames: ["operation", "backend"] as const,
    registers: [registry],
  });
  byRegistry.set(registry, counter);
  return counter;
}

/**
 * Wrap a Storage impl so every operation that throws increments the error
 * counter (and re-throws unchanged). `head`'s missing-object case returns null
 * inside the impl rather than throwing, so it is NOT counted as an error — only
 * genuine failures (e.g. a missing bucket) are.
 */
export function instrumentStorage(
  storage: Storage,
  registry: Registry,
  backend: Backend,
): Storage {
  const counter = errorCounter(registry);
  const wrap = <A extends unknown[], R>(
    operation: StorageOp,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        counter.inc({ operation, backend });
        throw err;
      }
    };
  };
  return {
    put: wrap("put", storage.put.bind(storage)),
    putMultipart: wrap("putMultipart", storage.putMultipart.bind(storage)),
    get: wrap("get", storage.get.bind(storage)),
    head: wrap("head", storage.head.bind(storage)),
    delete: wrap("delete", storage.delete.bind(storage)),
    list: wrap("list", storage.list.bind(storage)),
  };
}
