/**
 * Client-side telemetry helper. Fire-and-forget: every call returns
 * immediately; failures are silently swallowed so a telemetry hiccup never
 * affects the user's session.
 *
 * Event names use dot-case (see DashboardTelemetryRecordInput schema):
 *   recordTelemetry("inbox.viewed", { filterStatus: "all-open" });
 *   recordTelemetry("inbox.row_action", { action: "approve", viaKeyboard: true });
 *
 * The JWT cookie (`furan_jwt`, HttpOnly) attaches automatically via
 * `credentials: "include"`. Returns nothing — caller never awaits.
 */
import { browserEnv } from "./env";

export function recordTelemetry(
  event: string,
  props: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined") return; // no-op on server

  // browserEnv validates + defaults NEXT_PUBLIC_API_URL to http://localhost:3000
  // (raw process.env.NEXT_PUBLIC_API_URL is undefined when not set at build
  // time and would 404 against the dashboard's own origin — use the schema).
  const url = `${browserEnv.NEXT_PUBLIC_API_URL}/dashboard/telemetry`;

  void fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, props }),
    keepalive: true, // survives page unload — important for session_duration
  }).catch(() => {
    // intentionally swallowed
  });
}
