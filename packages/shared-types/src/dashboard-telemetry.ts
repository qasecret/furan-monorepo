import { z } from "zod";

/**
 * Event identifier — dot-case, lowercase, max 64 chars (e.g. `inbox.viewed`).
 * The pattern enforces a discoverable namespace shape so all events sort/group
 * consistently when queried.
 */
export const dashboardTelemetryEventName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z]+(\.[a-z_]+)+$/, "event must be dot.case lowercase");

/** Props payload — opaque map, capped at 32 keys to prevent abuse. */
export const dashboardTelemetryProps = z
  .record(z.unknown())
  .refine((v) => Object.keys(v).length <= 32, "max 32 props");

export const dashboardTelemetryRecordInput = z.object({
  event: dashboardTelemetryEventName,
  props: dashboardTelemetryProps.default({}),
});
export type DashboardTelemetryRecordInput = z.infer<
  typeof dashboardTelemetryRecordInput
>;
