package io.furan.sdk.plugin

import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.event.SharedFlowEventBus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PluginRegistrySpiTest {

    private fun ctx(capabilities: CapabilityRegistry = DefaultCapabilityRegistry()): PluginContext =
        PluginContext(
            config = DefaultConfigRegistry(emptyMap()),
            eventBus = SharedFlowEventBus(),
            capabilities = capabilities,
        )

    @Test
    fun `loadFromClasspath discovers the test-only TestFixturePlugin via ServiceLoader`() {
        val r = PluginRegistry()
        r.loadFromClasspath()
        val names = r.list().map { it.name }
        assertTrue(
            "test-fixture-plugin" in names,
            "Expected ServiceLoader to discover test-fixture-plugin via " +
                "src/test/resources/META-INF/services/io.furan.sdk.plugin.FuranPlugin. " +
                "Got plugins: $names",
        )
    }

    @Test
    fun `loadFromClasspath is idempotent — calling twice does not double-register`() {
        val r = PluginRegistry()
        r.loadFromClasspath()
        r.loadFromClasspath()
        val testFixtureEntries = r.list().count { it.name == "test-fixture-plugin" }
        assertEquals(1, testFixtureEntries)
    }

    @Test
    fun `SPI-loaded plugin's initialize advertises its capabilities`() {
        val r = PluginRegistry()
        r.loadFromClasspath()
        val capabilities = DefaultCapabilityRegistry()
        r.initializeAll(ctx(capabilities))

        assertTrue(capabilities.has(Capability.Tracing))
        assertEquals(listOf("test-fixture-plugin"), capabilities.providers(Capability.Tracing))
    }
}
