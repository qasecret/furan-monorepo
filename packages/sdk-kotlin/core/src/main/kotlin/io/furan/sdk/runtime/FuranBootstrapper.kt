package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigSource
import io.furan.sdk.config.ConfigurationResolver
import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.config.sources.EnvConfigSource
import io.furan.sdk.config.sources.SystemPropertyConfigSource
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
) {

    fun bootstrap(): FuranRuntime {
        val registry = ConfigurationResolver(sources).resolve()
        val eventBus = eventBusFactory()
        val stateMachine = StateMachine(eventBus)
        val runtime = FuranRuntime(
            config = registry,
            eventBus = eventBus,
            stateMachine = stateMachine,
        )
        stateMachine.transition(RuntimeState.READY)
        return runtime
    }

    companion object {
        /**
         * Default source list: env + sysprop + built-in defaults.
         * Operators add YAML / Spring sources by passing an explicit
         * list to the constructor.
         */
        fun autoDiscoverSources(): List<ConfigSource> = listOf(
            DefaultsConfigSource(),
            SystemPropertyConfigSource.forSystem(),
            EnvConfigSource.forSystem(),
        )
    }
}
