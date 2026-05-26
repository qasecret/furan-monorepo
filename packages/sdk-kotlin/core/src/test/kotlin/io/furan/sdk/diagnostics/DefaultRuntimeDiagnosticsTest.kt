package io.furan.sdk.diagnostics

import io.furan.sdk.config.ConfigValue
import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.event.SharedFlowEventBus
import io.furan.sdk.plugin.Capability
import io.furan.sdk.plugin.DefaultCapabilityRegistry
import io.furan.sdk.plugin.PluginRegistry
import io.furan.sdk.runtime.RuntimeState
import io.furan.sdk.runtime.StateMachine
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.time.TestTimeSource
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class, kotlin.time.ExperimentalTime::class)
class DefaultRuntimeDiagnosticsTest {

    @Test
    fun `snapshot composes state, uptime, provenance, plugins, capabilities, memory, and events`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus).also { it.transition(RuntimeState.READY) }

        val configRegistry = DefaultConfigRegistry(mapOf(
            "furan.endpoint" to ConfigValue("https://x", "env:FURAN_ENDPOINT", 100),
        ))
        val pluginRegistry = PluginRegistry()
        val capabilityRegistry = DefaultCapabilityRegistry().also {
            it.advertise(Capability.Tracing, "my-plugin")
        }

        val buf = RecentEventsBuffer(capacity = 16)
        buf.attach(bus)
        delay(10)

        val time = TestTimeSource()
        val diag = DefaultRuntimeDiagnostics(
            stateProvider = { sm.current() },
            startTime = time.markNow(),
            timeSource = time,
            configRegistry = configRegistry,
            pluginRegistry = pluginRegistry,
            capabilityRegistry = capabilityRegistry,
            recentEvents = buf,
        )

        time += 45.seconds

        val snap = diag.snapshot()
        assertEquals(RuntimeState.READY, snap.state)
        assertEquals(45.seconds, snap.uptime)
        assertEquals(1, snap.configProvenance.size)
        assertEquals("https://x", snap.configProvenance["furan.endpoint"]?.value)
        assertEquals(0, snap.plugins.size)
        assertEquals(1, snap.capabilities.size)
        assertEquals(listOf("my-plugin"), snap.capabilities["tracing"])
        assertTrue(snap.memory.heapCommittedBytes > 0)
        assertEquals(0, snap.recentEvents.size)

        buf.detach()
        bus.close()
    }

    @Test
    fun `snapshot tolerates null pluginRegistry and capabilityRegistry`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus).also { it.transition(RuntimeState.READY) }
        val time = TestTimeSource()
        val diag = DefaultRuntimeDiagnostics(
            stateProvider = { sm.current() },
            startTime = time.markNow(),
            timeSource = time,
            configRegistry = DefaultConfigRegistry(emptyMap()),
            pluginRegistry = null,
            capabilityRegistry = null,
            recentEvents = RecentEventsBuffer(capacity = 8),
        )

        val snap = diag.snapshot()
        assertEquals(emptyList<Any>(), snap.plugins)
        assertEquals(emptyMap<String, List<String>>(), snap.capabilities)

        bus.close()
    }

    @Test
    fun `snapshot recentEvents reflects events published before the call`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus)
        val buf = RecentEventsBuffer(capacity = 16)
        buf.attach(bus)
        delay(10)

        val time = TestTimeSource()
        val diag = DefaultRuntimeDiagnostics(
            stateProvider = { sm.current() },
            startTime = time.markNow(),
            timeSource = time,
            configRegistry = DefaultConfigRegistry(emptyMap()),
            pluginRegistry = null,
            capabilityRegistry = null,
            recentEvents = buf,
        )

        sm.transition(RuntimeState.READY)
        sm.transition(RuntimeState.DEGRADED)
        delay(10)

        val snap = diag.snapshot()
        assertEquals(2, snap.recentEvents.size)
        assertEquals("StateChangedEvent", snap.recentEvents[0].typeName)

        buf.detach()
        bus.close()
    }
}
