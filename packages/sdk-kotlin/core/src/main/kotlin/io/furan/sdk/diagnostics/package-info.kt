/**
 * Operator-facing diagnostics for the Furan SDK runtime.
 *
 * ## Entry points
 *  - [RuntimeDiagnostics] — single-method `snapshot()` interface.
 *  - [DefaultRuntimeDiagnostics] — composes the snapshot from the
 *    runtime's subsystems at call time.
 *  - [RuntimeSnapshot] — value type bundling state + uptime + config
 *    provenance + plugins + capabilities + memory + recent events.
 *
 * ## Helper types
 *  - [FuranEventSummary] — compact view of a `FuranEvent` for the
 *    recent-events ring buffer.
 *  - [MemoryStats] — JVM heap snapshot.
 *  - [RecentEventsBuffer] — bounded ring buffer subscribed to the
 *    runtime's `EventBus`; populates `RuntimeSnapshot.recentEvents`.
 *
 * ## Usage
 *
 * Diagnostics are wired by default — `runtime.diagnostics` is
 * non-null unless `FuranBootstrapper(enableDiagnostics = false)`
 * was used:
 *
 * ```kotlin
 * val rt = FuranBootstrapper().bootstrap()
 * val snap = rt.diagnostics!!.snapshot()
 * println("State: ${snap.state}, uptime: ${snap.uptime}")
 * println("Plugins: ${snap.plugins.map { it.name }}")
 * println("Recent events: ${snap.recentEvents.size}")
 * ```
 *
 * ## What's NOT in this phase
 *
 * `RuntimeSnapshot` lists what's available today. Future phases
 * extend the type (additive — new fields with defaults) as
 * subsystems land:
 *  - `activeEndpoint` / `endpointHistory` — Phase 3.5 transport
 *    publishes endpoint resolution events.
 *  - `queueDepths` — Phase 5 partitioned async queues.
 *  - `circuitBreakers` / `transportPool` / `retryStats` — Phase 3.5.
 *  - `tokenRefresh` — credential providers.
 *  - JSON serialization (`snapshot.toJson()`) — requires care for
 *    generic `ConfigValue<*>`; defer until a real actuator
 *    integration drives the contract.
 *  - Spring actuator `@Endpoint(id = "furan")` — lives in
 *    `furan-spring-boot-starter` (separate artifact).
 */
package io.furan.sdk.diagnostics
