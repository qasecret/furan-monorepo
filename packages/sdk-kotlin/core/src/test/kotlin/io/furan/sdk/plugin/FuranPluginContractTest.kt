package io.furan.sdk.plugin

import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.event.SharedFlowEventBus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FuranPluginContractTest {

    @Test
    fun `FuranPlugin has name, capabilities, initialize, and shutdown`() {
        var initCalled = false
        var shutdownCalled = false

        val plugin = object : FuranPlugin {
            override val name: String = "fake-plugin"
            override val capabilities: Set<Capability> = setOf(Capability.Tracing)
            override fun initialize(context: PluginContext) {
                initCalled = true
                context.capabilities.advertise(Capability.Tracing, name)
            }
            override fun shutdown() {
                shutdownCalled = true
            }
        }

        assertEquals("fake-plugin", plugin.name)
        assertEquals(setOf(Capability.Tracing), plugin.capabilities)

        val bus = SharedFlowEventBus()
        val capabilities = DefaultCapabilityRegistry()
        val ctx = PluginContext(
            config = DefaultConfigRegistry(emptyMap()),
            eventBus = bus,
            capabilities = capabilities,
        )
        plugin.initialize(ctx)
        assertTrue(initCalled)
        assertTrue(capabilities.has(Capability.Tracing))
        assertEquals(listOf("fake-plugin"), capabilities.providers(Capability.Tracing))

        plugin.shutdown()
        assertTrue(shutdownCalled)
        bus.close()
    }

    @Test
    fun `FuranPlugin shutdown has a no-op default`() {
        val plugin = object : FuranPlugin {
            override val name: String = "no-shutdown-plugin"
            override fun initialize(context: PluginContext) { /* no-op */ }
        }
        plugin.shutdown()
        assertTrue(true)
    }

    @Test
    fun `FuranPlugin capabilities has an empty default`() {
        val plugin = object : FuranPlugin {
            override val name: String = "no-caps-plugin"
            override fun initialize(context: PluginContext) { /* no-op */ }
        }
        assertEquals(emptySet<Capability>(), plugin.capabilities)
    }

    @Test
    fun `PluginInfo is a data class with name + capabilities`() {
        val info = PluginInfo(name = "x", capabilities = setOf(Capability.Tracing, Capability.Metrics))
        assertEquals("x", info.name)
        assertEquals(setOf(Capability.Tracing, Capability.Metrics), info.capabilities)
        assertEquals(info, info.copy())
    }
}
