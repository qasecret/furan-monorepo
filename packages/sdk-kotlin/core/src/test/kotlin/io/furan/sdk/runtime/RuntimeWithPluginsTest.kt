package io.furan.sdk.runtime

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.plugin.Capability
import io.furan.sdk.plugin.FuranPlugin
import io.furan.sdk.plugin.PluginContext
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

class RuntimeWithPluginsTest {

    private class RecordingPlugin(
        override val name: String,
        private val cap: Capability,
        private val initLog: CopyOnWriteArrayList<String>,
        private val shutdownLog: CopyOnWriteArrayList<String>,
    ) : FuranPlugin {
        override val capabilities: Set<Capability> = setOf(cap)
        override fun initialize(context: PluginContext) {
            initLog += name
            context.capabilities.advertise(cap, name)
        }
        override fun shutdown() {
            shutdownLog += name
        }
    }

    @Test
    fun `default bootstrap leaves runtime plugins and capabilities null`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        assertNull(rt.plugins)
        assertNull(rt.capabilities)
        rt.close()
    }

    @Test
    fun `bootstrap with explicit plugins initializes them and exposes capability registry`() {
        val initLog = CopyOnWriteArrayList<String>()
        val shutdownLog = CopyOnWriteArrayList<String>()

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            plugins = listOf(
                RecordingPlugin("plugin-a", Capability.Tracing, initLog, shutdownLog),
                RecordingPlugin("plugin-b", Capability.Metrics, initLog, shutdownLog),
            ),
        ).bootstrap()

        assertNotNull(rt.plugins)
        assertNotNull(rt.capabilities)
        assertEquals(listOf("plugin-a", "plugin-b"), initLog.toList())
        assertTrue(rt.capabilities!!.has(Capability.Tracing))
        assertTrue(rt.capabilities!!.has(Capability.Metrics))

        rt.close()
        assertEquals(listOf("plugin-b", "plugin-a"), shutdownLog.toList())
    }

    @Test
    fun `bootstrap with loadPluginsFromClasspath=true also discovers SPI plugins`() {
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            loadPluginsFromClasspath = true,
        ).bootstrap()

        assertNotNull(rt.plugins)
        val names = rt.plugins!!.list().map { it.name }
        assertTrue("test-fixture-plugin" in names, "got plugins: $names")
        assertTrue(rt.capabilities!!.has(Capability.Tracing))

        rt.close()
    }

    @Test
    fun `bootstrap calls shutdown on already-initialized plugins when a later plugin fails initialize`() {
        val initLog = java.util.concurrent.CopyOnWriteArrayList<String>()
        val shutdownLog = java.util.concurrent.CopyOnWriteArrayList<String>()

        class GoodPlugin(override val name: String) : io.furan.sdk.plugin.FuranPlugin {
            override fun initialize(context: io.furan.sdk.plugin.PluginContext) { initLog += name }
            override fun shutdown() { shutdownLog += name }
        }
        class BadPlugin : io.furan.sdk.plugin.FuranPlugin {
            override val name: String = "bad-plugin"
            override fun initialize(context: io.furan.sdk.plugin.PluginContext) {
                initLog += name
                error("simulated init failure")
            }
            override fun shutdown() { shutdownLog += name }
        }

        val ex = assertThrows(IllegalStateException::class.java) {
            FuranBootstrapper(
                sources = listOf(io.furan.sdk.config.sources.DefaultsConfigSource()),
                plugins = listOf(
                    GoodPlugin("good-1"),
                    GoodPlugin("good-2"),
                    BadPlugin(),
                ),
            ).bootstrap()
        }
        assertTrue(ex.message!!.contains("simulated init failure"))

        // good-1 + good-2 + bad were all attempted to initialize; bad threw.
        assertTrue(initLog.containsAll(listOf("good-1", "good-2", "bad-plugin")))

        // CRITICAL ASSERTION: good-1 and good-2 must have had shutdown() called
        // so they could release any resources they acquired in initialize().
        // bad-plugin's shutdown() is also called (best-effort — it may not have
        // acquired anything but the contract is to call shutdown on all initialized plugins).
        assertTrue(shutdownLog.containsAll(listOf("good-1", "good-2")))
    }
}
