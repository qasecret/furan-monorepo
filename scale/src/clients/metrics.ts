import type { Registry } from "@furan/telemetry";

type Labels = Record<string, string | number>;

interface Sample {
  metricName?: string;
  labels: Record<string, unknown>;
  value: number;
}

/** True when every wanted label is on the sample with that value. */
function matches(sample: Sample, wanted: Labels): boolean {
  return Object.entries(wanted).every(
    ([name, value]) => String(sample.labels[name]) === String(value),
  );
}

async function samples(registry: Registry, name: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(name);
  if (metric === undefined) {
    // Reading 0 from a metric that was never registered would make a suite
    // report a clean result for a measurement it never took.
    throw new Error(`metric ${name} is not registered`);
  }
  return (await metric.get()).values as Sample[];
}

const total = (found: Sample[]): number =>
  found.reduce((sum, sample) => sum + sample.value, 0);

/**
 * The observation count and sum of a histogram, over the label sets that carry
 * every label in `labels` (all of them when none is given).
 */
export async function readHistogram(
  registry: Registry,
  name: string,
  labels: Labels = {},
): Promise<{ count: number; sum: number }> {
  const found = (await samples(registry, name)).filter((s) =>
    matches(s, labels),
  );
  return {
    count: total(found.filter((s) => s.metricName === `${name}_count`)),
    sum: total(found.filter((s) => s.metricName === `${name}_sum`)),
  };
}

/** A counter's value, summed over the label sets that carry every label in `labels`. */
export async function readCounter(
  registry: Registry,
  name: string,
  labels: Labels = {},
): Promise<number> {
  return total(
    (await samples(registry, name)).filter((s) => matches(s, labels)),
  );
}

/** A histogram's cumulative buckets: `count` observations at or below `le`. */
export interface HistogramBuckets {
  /** Ascending by `le`; the last is `+Inf` (`Infinity`), holding every observation. */
  buckets: { le: number; count: number }[];
  count: number;
}

/**
 * A histogram's cumulative bucket counts, summed over the label sets that
 * carry every label in `labels` (all of them when none is given).
 */
export async function readBuckets(
  registry: Registry,
  name: string,
  labels: Labels = {},
): Promise<HistogramBuckets> {
  const byLe = new Map<number, number>();
  for (const s of await samples(registry, name)) {
    if (s.metricName !== `${name}_bucket` || !matches(s, labels)) continue;
    const le = s.labels.le === "+Inf" ? Infinity : Number(s.labels.le);
    byLe.set(le, (byLe.get(le) ?? 0) + s.value);
  }
  const buckets = [...byLe]
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le);
  return { buckets, count: buckets.at(-1)?.count ?? 0 };
}

/**
 * A gauge's value, averaged over the label sets that carry every label in
 * `labels`; null when none has a value. Reading it runs the gauge's own
 * `collect`, if it has one.
 */
export async function readGauge(
  registry: Registry,
  name: string,
  labels: Labels = {},
): Promise<number | null> {
  const found = (await samples(registry, name)).filter((s) =>
    matches(s, labels),
  );
  return found.length === 0 ? null : total(found) / found.length;
}
