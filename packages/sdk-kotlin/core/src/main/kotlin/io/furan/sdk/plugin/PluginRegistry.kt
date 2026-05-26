package io.furan.sdk.plugin

import java.util.ServiceLoader
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Holds the set of [FuranPlugin]s active for a single runtime
 * instance. Built and populated by [io.furan.sdk.runtime.FuranBootstrapper];
 * exposed read-only on [io.furan.sdk.runtime.FuranRuntime.plugins].
 *
 * Two registration paths:
 *  - **Explicit:** [add] — caller supplies a plugin instance. The
 *    typical path for hand-rolled plugins or tests.
 *  - **SPI:** [loadFromClasspath] — uses [java.util.ServiceLoader] to
 *    discover plugins declared in
 *    `META-INF/services/io.furan.sdk.plugin.FuranPlugin` files on the
 *    classpath. Each line in such a file is a fully-qualified class
 *    name; the class MUST have a public no-arg constructor.
 *
 * Lifecycle:
 *  - [initializeAll] runs registered plugins in registration order.
 *  - [shutdownAll] runs in REVERSE registration order. Each plugin's
 *    `shutdown()` is wrapped in `runCatching` — one failing plugin
 *    must not prevent the others from cleaning up.
 *
 * Thread-safety: the internal list is a [CopyOnWriteArrayList], so
 * iteration during reads doesn't block writes. Mutation expected to
 * happen during bootstrap only; concurrent `add` is supported but
 * not encouraged.
 */
class PluginRegistry {

    private val plugins: CopyOnWriteArrayList<FuranPlugin> = CopyOnWriteArrayList()

    /** Register [plugin] explicitly. Order matters for
     *  initialize/shutdown ordering. */
    fun add(plugin: FuranPlugin) {
        plugins += plugin
    }

    /** Discover plugins via [ServiceLoader] and add each one in the
     *  order returned by the JDK (deterministic per classpath order
     *  on the JVM). Idempotent — calling twice does not re-add. */
    fun loadFromClasspath() {
        val loader = ServiceLoader.load(FuranPlugin::class.java)
        val alreadyRegistered = plugins.map { it.javaClass.name }.toSet()
        for (plugin in loader) {
            if (plugin.javaClass.name in alreadyRegistered) continue
            plugins += plugin
        }
    }

    /** Initialize every registered plugin in registration order. */
    fun initializeAll(context: PluginContext) {
        for (plugin in plugins) {
            plugin.initialize(context)
        }
    }

    /** Shut down every registered plugin in REVERSE registration
     *  order. Each plugin's `shutdown()` is wrapped in `runCatching`
     *  so one failure does not prevent others from running. */
    fun shutdownAll() {
        for (plugin in plugins.reversed()) {
            runCatching { plugin.shutdown() }
        }
    }

    /** Diagnostic snapshot of the registered plugins. */
    fun list(): List<PluginInfo> =
        plugins.map { PluginInfo(name = it.name, capabilities = it.capabilities) }
}
