import type { Registry } from "prom-client";

/** One sample of a prom-client metric, as `getMetricsAsJSON` returns it. */
export type Sample = {
  metricName?: string;
  labels: Record<string, string | number | undefined>;
  value: number;
};

/** `_count` and `_sum` of one histogram series (optionally under a label). */
export async function histogramSeries(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<{ count: number; sum: number }> {
  const metric = (await registry.getMetricsAsJSON()).find(
    (m) => m.name === name,
  );
  if (!metric) return { count: 0, sum: 0 };
  const samples = metric.values as Sample[];
  const pick = (suffix: string): number =>
    samples.find(
      (s) =>
        s.metricName === `${name}${suffix}` &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value ?? 0;
  return { count: pick("_count"), sum: pick("_sum") };
}

/** The summed value of a counter, over all its series. */
export async function counterValue(
  registry: Registry,
  name: string,
): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find(
    (m) => m.name === name,
  );
  return ((metric?.values ?? []) as Sample[]).reduce(
    (sum, s) => sum + s.value,
    0,
  );
}
