package io.furan.sdk.plugin

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.event.SharedFlowEventBus
import io.furan.sdk.event.subscribe
import io.furan.sdk.runtime.FuranBootstrapper
import io.furan.sdk.runtime.RuntimeState
import io.furan.sdk.runtime.StateChangedEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class Phase4EndToEndTest {

    @Test
    fun `bootstrap with both explicit and SPI plugins initializes all of them`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()

        class ExplicitPlugin : FuranPlugin {
            override val name: String = "explicit-plugin"
            override val capabilities: Set<Capability> = setOf(Capability.VaultSupport)
            override fun initialize(context: PluginContext) {
                initLog += name
                context.capabilities.advertise(Capability.VaultSupport, name)
            }
            override fun shutdown() {
                shutdownLog += name
            }
        }

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            plugins = listOf(ExplicitPlugin()),
            loadPluginsFromClasspath = true,
        ).bootstrap()

        // Both plugins should be in the registry.
        val names = rt.plugins!!.list().map { it.name }
        assertTrue("explicit-plugin" in names)
        assertTrue("test-fixture-plugin" in names)

        // Both initialized — explicit first (registration order), SPI second.
        assertTrue(initLog.contains("explicit-plugin"))

        // Capabilities from BOTH plugins are visible in the registry.
        assertTrue(rt.capabilities!!.has(Capability.VaultSupport))
        assertTrue(rt.capabilities!!.has(Capability.Tracing))  // from TestFixturePlugin

        rt.close()
        // Explicit plugin's shutdown ran (TestFixturePlugin has the default no-op).
        assertTrue(shutdownLog.contains("explicit-plugin"))
    }

    @Test
    fun `plugin can subscribe to EventBus during initialize and receive events`() = runTest {
        val events = CopyOnWriteArrayList<StateChangedEvent>()

        class SubscriberPlugin : FuranPlugin {
            override val name: String = "subscriber-plugin"
            override fun initialize(context: PluginContext) {
                context.eventBus.subscribe<StateChangedEvent> { events += it }
            }
        }

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            plugins = listOf(SubscriberPlugin()),
            eventBusFactory = { SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler)) },
        ).bootstrap()

        // Plugin initialize runs BEFORE stateMachine.transition(READY),
        // so the READY transition should land on the subscriber.
        delay(10)

        assertNotNull(rt.plugins)
        assertEquals(1, events.size)
        assertEquals(RuntimeState.INITIALIZING, events[0].from)
        assertEquals(RuntimeState.READY, events[0].to)

        rt.close()
    }
}
