package io.furan.sdk.diagnostics

import io.furan.sdk.config.ConfigValue
import io.furan.sdk.plugin.Capability
import io.furan.sdk.plugin.PluginInfo
import io.furan.sdk.runtime.RuntimeState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class RuntimeSnapshotTest {

    @Test
    fun `RuntimeSnapshot bundles all currently-available fields`() {
        val snap = RuntimeSnapshot(
            state = RuntimeState.READY,
            uptime = 2.minutes + 30.seconds,
            configProvenance = mapOf(
                "furan.endpoint" to ConfigValue("https://x", "env:FURAN_ENDPOINT", 100),
            ),
            plugins = listOf(
                PluginInfo(name = "my-plugin", capabilities = setOf(Capability.Tracing)),
            ),
            capabilities = mapOf("tracing" to listOf("my-plugin")),
            memory = MemoryStats(heapUsedBytes = 100, heapCommittedBytes = 200, heapMaxBytes = 1000),
            recentEvents = emptyList(),
        )
        assertEquals(RuntimeState.READY, snap.state)
        assertEquals(150.seconds, snap.uptime)
        assertEquals(1, snap.configProvenance.size)
        assertEquals(1, snap.plugins.size)
        assertEquals(1, snap.capabilities.size)
        assertEquals(100, snap.memory.heapUsedBytes)
        assertEquals(emptyList<FuranEventSummary>(), snap.recentEvents)
    }

    @Test
    fun `RuntimeSnapshot has sensible empty defaults for optional collections`() {
        val snap = RuntimeSnapshot(
            state = RuntimeState.INITIALIZING,
            uptime = 0.seconds,
            memory = MemoryStats(0, 0, 0),
        )
        assertEquals(emptyMap<String, ConfigValue<*>>(), snap.configProvenance)
        assertEquals(emptyList<PluginInfo>(), snap.plugins)
        assertEquals(emptyMap<String, List<String>>(), snap.capabilities)
        assertEquals(emptyList<FuranEventSummary>(), snap.recentEvents)
    }
}
