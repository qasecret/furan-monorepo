package io.furan.sdk.diagnostics

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.event.SharedFlowEventBus
import io.furan.sdk.plugin.Capability
import io.furan.sdk.plugin.FuranPlugin
import io.furan.sdk.plugin.PluginContext
import io.furan.sdk.runtime.FuranBootstrapper
import io.furan.sdk.runtime.RuntimeState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class Phase6EndToEndTest {

    @Test
    fun `bootstrap then snapshot returns READY with provenance, plugins, capabilities, and recent events`() = runTest {
        class TracingPlugin : FuranPlugin {
            override val name: String = "tracing-plugin"
            override val capabilities: Set<Capability> = setOf(Capability.Tracing)
            override fun initialize(context: PluginContext) {
                context.capabilities.advertise(Capability.Tracing, name)
            }
        }

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            plugins = listOf(TracingPlugin()),
            eventBusFactory = { SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler)) },
        ).bootstrap()

        // Drive a transition so recentEvents has something in it.
        rt.stateMachine.transition(RuntimeState.DEGRADED)
        delay(20)

        val snap = rt.diagnostics!!.snapshot()
        assertEquals(RuntimeState.DEGRADED, snap.state)
        assertTrue(snap.uptime.inWholeMilliseconds >= 0)
        // Config provenance contains the default values from DefaultsConfigSource.
        assertTrue(snap.configProvenance.isNotEmpty())
        // Plugins were advertised.
        assertEquals(1, snap.plugins.size)
        assertEquals("tracing-plugin", snap.plugins[0].name)
        // Capabilities advertise correctly.
        assertEquals(listOf("tracing-plugin"), snap.capabilities["tracing"])
        // Memory looks plausible.
        assertTrue(snap.memory.heapCommittedBytes > 0)
        // Recent events captured the INITIALIZING→READY and READY→DEGRADED transitions.
        assertTrue(snap.recentEvents.size >= 2)
        val descs = snap.recentEvents.map { it.description }
        assertTrue(descs.any { it.contains("INITIALIZING") }, "events: $descs")
        assertTrue(descs.any { it.contains("DEGRADED") }, "events: $descs")

        rt.close()
    }

    @Test
    fun `diagnostics tolerates a runtime with no plugins or endpoint resolver`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        val snap = rt.diagnostics!!.snapshot()
        assertNotNull(snap)
        assertEquals(emptyList<Any>(), snap.plugins)
        assertEquals(emptyMap<String, List<String>>(), snap.capabilities)
        rt.close()
    }
}
