package io.furan.sdk.plugin

import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.event.SharedFlowEventBus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

class PluginRegistryTest {

    private class RecordingPlugin(
        override val name: String,
        override val capabilities: Set<Capability> = emptySet(),
        private val initLog: CopyOnWriteArrayList<String>,
        private val shutdownLog: CopyOnWriteArrayList<String>,
        private val throwOnShutdown: Boolean = false,
    ) : FuranPlugin {
        override fun initialize(context: PluginContext) {
            initLog += name
            capabilities.forEach { context.capabilities.advertise(it, name) }
        }
        override fun shutdown() {
            shutdownLog += name
            if (throwOnShutdown) error("$name boom")
        }
    }

    private fun ctx(capabilities: CapabilityRegistry = DefaultCapabilityRegistry()): PluginContext {
        return PluginContext(
            config = DefaultConfigRegistry(emptyMap()),
            eventBus = SharedFlowEventBus(),
            capabilities = capabilities,
        )
    }

    @Test
    fun `empty registry has no plugins`() {
        val r = PluginRegistry()
        assertEquals(emptyList<PluginInfo>(), r.list())
    }

    @Test
    fun `add registers a plugin and list reflects it`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()
        val r = PluginRegistry()
        r.add(RecordingPlugin("p1", setOf(Capability.Tracing), initLog, shutdownLog))
        val infos = r.list()
        assertEquals(1, infos.size)
        assertEquals("p1", infos[0].name)
        assertEquals(setOf(Capability.Tracing), infos[0].capabilities)
    }

    @Test
    fun `initializeAll runs in registration order and advertises capabilities`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()
        val r = PluginRegistry()
        r.add(RecordingPlugin("p1", setOf(Capability.Tracing), initLog, shutdownLog))
        r.add(RecordingPlugin("p2", setOf(Capability.Metrics), initLog, shutdownLog))
        r.add(RecordingPlugin("p3", emptySet(), initLog, shutdownLog))

        val capabilities = DefaultCapabilityRegistry()
        r.initializeAll(ctx(capabilities))

        assertEquals(listOf("p1", "p2", "p3"), initLog.toList())
        assertTrue(capabilities.has(Capability.Tracing))
        assertTrue(capabilities.has(Capability.Metrics))
        assertEquals(listOf("p1"), capabilities.providers(Capability.Tracing))
        assertEquals(listOf("p2"), capabilities.providers(Capability.Metrics))
    }

    @Test
    fun `shutdownAll runs in REVERSE registration order`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()
        val r = PluginRegistry()
        r.add(RecordingPlugin("p1", emptySet(), initLog, shutdownLog))
        r.add(RecordingPlugin("p2", emptySet(), initLog, shutdownLog))
        r.add(RecordingPlugin("p3", emptySet(), initLog, shutdownLog))

        r.initializeAll(ctx())
        r.shutdownAll()

        assertEquals(listOf("p3", "p2", "p1"), shutdownLog.toList())
    }

    @Test
    fun `a failing shutdown does not prevent other plugins from being shut down`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()
        val r = PluginRegistry()
        r.add(RecordingPlugin("p1", emptySet(), initLog, shutdownLog))
        r.add(RecordingPlugin("p2", emptySet(), initLog, shutdownLog, throwOnShutdown = true))
        r.add(RecordingPlugin("p3", emptySet(), initLog, shutdownLog))

        r.initializeAll(ctx())
        r.shutdownAll()  // p2 will throw; p1 + p3 must still appear in the log

        assertTrue(shutdownLog.contains("p1"))
        assertTrue(shutdownLog.contains("p2"))
        assertTrue(shutdownLog.contains("p3"))
        assertEquals(3, shutdownLog.size)
    }
}
