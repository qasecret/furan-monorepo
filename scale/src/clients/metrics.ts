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
