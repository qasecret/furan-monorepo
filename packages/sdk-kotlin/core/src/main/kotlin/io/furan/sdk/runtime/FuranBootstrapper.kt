package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigSource
import io.furan.sdk.config.ConfigurationResolver
import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.config.sources.EnvConfigSource
import io.furan.sdk.config.sources.SystemPropertyConfigSource
import io.furan.sdk.config.sources.YamlConfigSource
import io.furan.sdk.event.EventBus
import io.furan.sdk.event.SharedFlowEventBus

/**
 * Builds a fully-initialized [FuranRuntime] from a list of
 * [ConfigSource]s. Transient: no state held between invocations.
 *
 * The bootstrap sequence (v2 spec §6.1):
 *  1. Resolve config via [ConfigurationResolver].
 *  2. Build the event-bus spine.
 *  3. Build the [StateMachine] (starts at [RuntimeState.INITIALIZING]).
 *  4. Assemble the [FuranRuntime].
 *  5. Transition INITIALIZING → READY.
 *  6. Return the runtime.
 *
 * Future phases will extend step 4 with transport, endpoint resolver,
 * async subsystem, plugins, and diagnostics.
 */
class FuranBootstrapper(
    private val sources: List<ConfigSource> = autoDiscoverSources(),
    private val eventBusFactory: () -> EventBus = ::SharedFlowEventBus,
    private val endpointConfig: io.furan.sdk.endpoint.EndpointResolutionConfig? = null,
    private val plugins: List<io.furan.sdk.plugin.FuranPlugin> = emptyList(),
    private val loadPluginsFromClasspath: Boolean = false,
    private val enableDiagnostics: Boolean = true,
    private val httpTransportFactory: (() -> io.furan.sdk.http.HttpTransport)? = null,
) {

    @OptIn(kotlin.time.ExperimentalTime::class)
    fun bootstrap(): FuranRuntime {
        val registry = ConfigurationResolver(sources).resolve()
        val eventBus = eventBusFactory()
        val stateMachine = StateMachine(eventBus)
        val endpointResolver = buildEndpointResolver(endpointConfig)
        // The feedback channel is exposed iff the resolver itself implements it.
        // Today only FailoverEndpointResolver does; future decorators wrapping
        // Failover should ALSO implement EndpointFeedback (forwarding to inner)
        // to keep this path working through the chain.
        val endpointFeedback = endpointResolver as? io.furan.sdk.endpoint.EndpointFeedback

        val (pluginRegistry, capabilityRegistry) = buildPluginRegistries(registry, eventBus)

        val diagnostics = if (enableDiagnostics) {
            val timeSource = kotlin.time.TimeSource.Monotonic
            val startMark = timeSource.markNow()
            val eventsBuffer = io.furan.sdk.diagnostics.RecentEventsBuffer()
            eventsBuffer.attach(eventBus)
            io.furan.sdk.diagnostics.DefaultRuntimeDiagnostics(
                stateProvider = { stateMachine.current() },
                startTime = startMark,
                timeSource = timeSource,
                configRegistry = registry,
                pluginRegistry = pluginRegistry,
                capabilityRegistry = capabilityRegistry,
                recentEvents = eventsBuffer,
            )
        } else null

        val httpTransport = httpTransportFactory?.invoke()

        val runtime = FuranRuntime(
            config = registry,
            eventBus = eventBus,
            stateMachine = stateMachine,
            endpointResolver = endpointResolver,
            endpointFeedback = endpointFeedback,
            plugins = pluginRegistry,
            capabilities = capabilityRegistry,
            diagnostics = diagnostics,
            httpTransport = httpTransport,
        )
        stateMachine.transition(RuntimeState.READY)
        return runtime
    }

    private fun buildPluginRegistries(
        config: io.furan.sdk.config.ConfigRegistry,
        eventBus: EventBus,
    ): Pair<io.furan.sdk.plugin.PluginRegistry?, io.furan.sdk.plugin.CapabilityRegistry?> {
        if (plugins.isEmpty() && !loadPluginsFromClasspath) {
            return null to null
        }

        val pluginRegistry = io.furan.sdk.plugin.PluginRegistry()
        plugins.forEach(pluginRegistry::add)
        if (loadPluginsFromClasspath) {
            pluginRegistry.loadFromClasspath()
        }

        val capabilityRegistry = io.furan.sdk.plugin.DefaultCapabilityRegistry()
        val ctx = io.furan.sdk.plugin.PluginContext(
            config = config,
            eventBus = eventBus,
            capabilities = capabilityRegistry,
        )
        // Critical: if any plugin's initialize() throws, ensure the
        // already-initialized plugins get their shutdown() called so
        // they release any resources they acquired (HTTP clients,
        // file watchers, etc). Then re-throw so bootstrap() fails
        // fast — partial-init runtimes are never returned to callers.
        try {
            pluginRegistry.initializeAll(ctx)
        } catch (t: Throwable) {
            runCatching { pluginRegistry.shutdownAll() }
            throw t
        }

        return pluginRegistry to capabilityRegistry
    }

    private fun buildEndpointResolver(
        cfg: io.furan.sdk.endpoint.EndpointResolutionConfig?,
    ): io.furan.sdk.endpoint.EndpointResolver? {
        if (cfg == null || cfg.primary == null) return null
        val static = io.furan.sdk.endpoint.StaticEndpointResolver(
            primary = cfg.primary,
            fallbacks = cfg.fallbacks,
            ttl = cfg.ttl,
        )
        return if (cfg.failoverEnabled) {
            io.furan.sdk.endpoint.FailoverEndpointResolver(
                inner = static,
                demoteWindow = cfg.failoverDemoteWindow,
            )
        } else static
    }

    companion object {
        /**
         * Default source list: env + sysprop + classpath `application.yml`
         * + built-in defaults. Mirrors the ReportPortal / Spring Boot
         * pattern — drop an `application.yml` on the classpath and it
         * gets picked up automatically; absent file = empty contribution
         * (non-fatal). Precedence (high → low) is fixed by each source's
         * `ConfigPriority`: env > sysprop > yaml > defaults, regardless
         * of list order. Operators add additional sources by passing an
         * explicit list to the constructor.
         */
        fun autoDiscoverSources(): List<ConfigSource> = listOf(
            DefaultsConfigSource(),
            YamlConfigSource.forClasspath("application.yml"),
            SystemPropertyConfigSource.forSystem(),
            EnvConfigSource.forSystem(),
        )
    }
}
