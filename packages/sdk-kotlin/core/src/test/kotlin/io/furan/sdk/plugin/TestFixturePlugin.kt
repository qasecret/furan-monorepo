package io.furan.sdk.plugin

/**
 * Test-only [FuranPlugin] discovered by [PluginRegistry.loadFromClasspath]
 * through the `META-INF/services/io.furan.sdk.plugin.FuranPlugin`
 * file in `src/test/resources`. NOT shipped with the production jar.
 *
 * The no-arg constructor is required by `ServiceLoader` — this is
 * the canonical pattern for SPI plugins.
 */
class TestFixturePlugin : FuranPlugin {
    override val name: String = "test-fixture-plugin"
    override val capabilities: Set<Capability> = setOf(Capability.Tracing)

    override fun initialize(context: PluginContext) {
        context.capabilities.advertise(Capability.Tracing, name)
    }
}
