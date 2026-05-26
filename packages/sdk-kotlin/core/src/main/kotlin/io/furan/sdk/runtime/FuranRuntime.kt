package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigRegistry
import io.furan.sdk.event.EventBus
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The central runtime container for an SDK instance. Phase 2 ships a
 * minimal surface — just config + bus + state machine — and later
 * phases add the transport, endpoint resolver, async subsystem, and
 * plugin registry as additional members. Built by [FuranBootstrapper].
 *
 * Lifecycle:
 *  1. After construction, the runtime is in [RuntimeState.INITIALIZING].
 *  2. The bootstrapper transitions to [RuntimeState.READY] once it
 *     has validated config and wired all subsystems.
 *  3. [close] transitions through [RuntimeState.SHUTTING_DOWN] to
 *     [RuntimeState.TERMINATED] and disposes owned resources (the
 *     event bus's coroutine scope).
 *
 * Closing is idempotent.
 */
class FuranRuntime internal constructor(
    val config: ConfigRegistry,
    val eventBus: EventBus,
    val stateMachine: StateMachine,
    val endpointResolver: io.furan.sdk.endpoint.EndpointResolver? = null,
    val endpointFeedback: io.furan.sdk.endpoint.EndpointFeedback? = null,
    val plugins: io.furan.sdk.plugin.PluginRegistry? = null,
    val capabilities: io.furan.sdk.plugin.CapabilityRegistry? = null,
    val diagnostics: io.furan.sdk.diagnostics.RuntimeDiagnostics? = null,
) : AutoCloseable {

    private val closed = AtomicBoolean(false)

    /** Current lifecycle state. */
    val state: RuntimeState get() = stateMachine.current()

    override fun close() {
        if (!closed.compareAndSet(false, true)) return

        try {
            // Shut down plugins first so they can drain any background
            // work that depends on the event bus / config / capabilities
            // before those go away. Each shutdown is failure-isolated
            // inside PluginRegistry.shutdownAll().
            plugins?.shutdownAll()
            // RecentEventsBuffer (when diagnostics is wired) holds an
            // EventBus subscription; it's cancelled automatically when
            // the bus closes below (supervisor scope cancellation).

            val current = stateMachine.current()
            when (current) {
                // INITIALIZING aborts directly to TERMINATED (spec §11
                // allows INITIALIZING → TERMINATED as the abort path).
                RuntimeState.INITIALIZING -> stateMachine.transition(RuntimeState.TERMINATED)

                // Already past the lifecycle — nothing to do.
                RuntimeState.SHUTTING_DOWN -> {
                    if (stateMachine.current() != RuntimeState.TERMINATED) {
                        stateMachine.transition(RuntimeState.TERMINATED)
                    }
                }
                RuntimeState.TERMINATED -> { /* already done */ }

                // Normal shutdown path from READY / DEGRADED / RELOADING.
                else -> {
                    stateMachine.transition(RuntimeState.SHUTTING_DOWN)
                    stateMachine.transition(RuntimeState.TERMINATED)
                }
            }
        } finally {
            // Dispose the bus if it owns resources to release. Future
            // impls (instrumented wrappers, test doubles) just need to
            // implement AutoCloseable to participate.
            (eventBus as? AutoCloseable)?.close()
        }
    }
}
