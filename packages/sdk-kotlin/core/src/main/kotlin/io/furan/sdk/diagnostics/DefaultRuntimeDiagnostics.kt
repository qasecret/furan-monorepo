package io.furan.sdk.diagnostics

import io.furan.sdk.config.ConfigRegistry
import io.furan.sdk.plugin.CapabilityRegistry
import io.furan.sdk.plugin.PluginRegistry
import io.furan.sdk.runtime.RuntimeState
import kotlin.time.ExperimentalTime
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/**
 * Default implementation. Composes the snapshot from the runtime's
 * subsystems at call time. Pure read-only — no mutation, no caching.
 *
 * Construction parameters are injected so the runtime can build one
 * during bootstrap and unit tests can wire fakes. In production,
 * [io.furan.sdk.runtime.FuranBootstrapper] populates these from the
 * runtime's own registries.
 *
 * Uptime is computed against a [TimeSource]-backed [TimeMark] taken
 * at bootstrap; tests inject `TestTimeSource` to drive elapsed time
 * deterministically.
 */
@OptIn(ExperimentalTime::class)
class DefaultRuntimeDiagnostics(
    private val stateProvider: () -> RuntimeState,
    private val startTime: TimeMark,
    @Suppress("UNUSED_PARAMETER") timeSource: TimeSource = TimeSource.Monotonic,
    private val configRegistry: ConfigRegistry,
    private val pluginRegistry: PluginRegistry?,
    private val capabilityRegistry: CapabilityRegistry?,
    private val recentEvents: RecentEventsBuffer,
) : RuntimeDiagnostics {

    override fun snapshot(): RuntimeSnapshot {
        val state = stateProvider()
        val uptime = startTime.elapsedNow()
        val provenance = configRegistry.provenance()
        val plugins = pluginRegistry?.list() ?: emptyList()
        val caps = capabilityRegistry?.all()?.mapKeys { (cap, _) -> cap.key } ?: emptyMap()
        val mem = MemoryStats.snapshot()
        val events = recentEvents.snapshot()
        return RuntimeSnapshot(
            state = state,
            uptime = uptime,
            memory = mem,
            configProvenance = provenance,
            plugins = plugins,
            capabilities = caps,
            recentEvents = events,
        )
    }
}
