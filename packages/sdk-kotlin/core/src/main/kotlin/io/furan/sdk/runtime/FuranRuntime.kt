package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigRegistry
import io.furan.sdk.event.EventBus
import io.furan.sdk.event.SharedFlowEventBus
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
) : AutoCloseable {

    private val closed = AtomicBoolean(false)

    /** Current lifecycle state. */
    val state: RuntimeState get() = stateMachine.current()

    override fun close() {
        if (!closed.compareAndSet(false, true)) return

        // Best-effort transitions; if we're already past SHUTTING_DOWN
        // (e.g. a test put us in TERMINATED directly) skip the move.
        val current = stateMachine.current()
        if (current != RuntimeState.SHUTTING_DOWN && current != RuntimeState.TERMINATED) {
            stateMachine.transition(RuntimeState.SHUTTING_DOWN)
        }
        if (stateMachine.current() != RuntimeState.TERMINATED) {
            stateMachine.transition(RuntimeState.TERMINATED)
        }

        // Dispose the bus's internal scope if we own a closeable impl.
        (eventBus as? SharedFlowEventBus)?.close()
    }
}
