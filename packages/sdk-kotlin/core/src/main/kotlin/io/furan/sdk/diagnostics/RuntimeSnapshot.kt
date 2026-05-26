package io.furan.sdk.diagnostics

import io.furan.sdk.config.ConfigValue
import io.furan.sdk.plugin.PluginInfo
import io.furan.sdk.runtime.RuntimeState
import kotlin.time.Duration

/**
 * Operator-grade snapshot of a [io.furan.sdk.runtime.FuranRuntime]
 * at a moment in time. Returned by
 * [RuntimeDiagnostics.snapshot]; intended for the Spring actuator
 * endpoint, CLI dump helpers, and support-ticket attachments.
 *
 * Phase 6 ships what's actually retrievable from the current runtime.
 * Future phases extend this class (additive — new fields with
 * defaults) as subsystems land:
 *  - `activeEndpoint` / `endpointHistory` — when the transport layer
 *    (Phase 3.5) starts publishing endpoint resolution events.
 *  - `queueDepths` — when partitioned async queues ship (Phase 5).
 *  - `circuitBreakers` / `transportPool` / `retryStats` — Phase 3.5.
 *  - `tokenRefresh` — when credential providers land.
 */
data class RuntimeSnapshot(
    val state: RuntimeState,
    val uptime: Duration,
    val memory: MemoryStats,
    val configProvenance: Map<String, ConfigValue<*>> = emptyMap(),
    val plugins: List<PluginInfo> = emptyList(),
    val capabilities: Map<String, List<String>> = emptyMap(),
    val recentEvents: List<FuranEventSummary> = emptyList(),
)
