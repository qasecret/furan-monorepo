package io.furan.sdk.runtime

import io.furan.sdk.event.EventBus
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the [RuntimeState] for a single [FuranRuntime]. Transitions
 * are atomic (CAS-driven) and broadcast a [StateChangedEvent] on the
 * supplied [EventBus] only after the state has been committed.
 *
 * Allowed transitions (v2 spec §11):
 *
 * ```
 * INITIALIZING  → READY | TERMINATED
 * READY         → DEGRADED | RELOADING | SHUTTING_DOWN
 * DEGRADED      → READY | SHUTTING_DOWN
 * RELOADING     → READY | DEGRADED | SHUTTING_DOWN
 * SHUTTING_DOWN → TERMINATED
 * TERMINATED    → (terminal)
 * ```
 *
 * Implementation note: we use an explicit `throw IllegalStateException`
 * because the failure mode is a state-machine violation, not a bad
 * argument. (`require(...)` would throw `IllegalArgumentException`.)
 */
class StateMachine(private val eventBus: EventBus) {

    private val state = AtomicReference(RuntimeState.INITIALIZING)

    fun current(): RuntimeState = state.get()

    /**
     * Atomically transition to [to]. Throws [IllegalStateException]
     * if the move from the current state to [to] is not allowed;
     * the state is left unchanged in that case.
     */
    fun transition(to: RuntimeState, correlationId: String? = null) {
        val from = state.get()
        if (!isAllowed(from, to)) {
            throw IllegalStateException("Illegal RuntimeState transition: $from -> $to")
        }
        if (!state.compareAndSet(from, to)) {
            // Another thread moved us in the meantime; refuse rather
            // than retry — the caller should reason about ordering.
            throw IllegalStateException(
                "Concurrent RuntimeState transition collision (was $from, expected $to)",
            )
        }
        eventBus.publish(StateChangedEvent(from = from, to = to, correlationId = correlationId))
    }

    private fun isAllowed(from: RuntimeState, to: RuntimeState): Boolean = when (from) {
        RuntimeState.INITIALIZING  -> to == RuntimeState.READY || to == RuntimeState.TERMINATED
        RuntimeState.READY         -> to == RuntimeState.DEGRADED || to == RuntimeState.RELOADING || to == RuntimeState.SHUTTING_DOWN
        RuntimeState.DEGRADED      -> to == RuntimeState.READY || to == RuntimeState.SHUTTING_DOWN
        RuntimeState.RELOADING     -> to == RuntimeState.READY || to == RuntimeState.DEGRADED || to == RuntimeState.SHUTTING_DOWN
        RuntimeState.SHUTTING_DOWN -> to == RuntimeState.TERMINATED
        RuntimeState.TERMINATED    -> false
    }
}
