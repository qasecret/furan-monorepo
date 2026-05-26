package io.furan.sdk.diagnostics

import io.furan.sdk.event.EventBus
import io.furan.sdk.event.Subscription
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicReference

/**
 * Bounded ring buffer of the most-recent [FuranEventSummary]s seen on
 * an attached [io.furan.sdk.event.EventBus]. Used by
 * [DefaultRuntimeDiagnostics] to populate the `recentEvents` field
 * of [RuntimeSnapshot] without holding strong references to large
 * event payloads.
 *
 * Capacity defaults to 64; older entries are dropped when the buffer
 * fills (drop-oldest, matching the bus's own overflow policy).
 *
 * Thread-safety: writes (from the bus subscriber) and reads (from
 * `snapshot()`) coordinate via a synchronized `ArrayDeque`. The
 * read returns an immutable copy so later writes don't mutate
 * previously-returned snapshots.
 *
 * Lifecycle: [attach] subscribes to the bus; [detach] cancels the
 * subscription.
 */
class RecentEventsBuffer(
    private val capacity: Int = DEFAULT_CAPACITY,
) {
    init {
        require(capacity > 0) { "RecentEventsBuffer.capacity must be > 0 (got $capacity)" }
    }

    private val deque = ArrayDeque<FuranEventSummary>(capacity)
    private val subscription = AtomicReference<Subscription?>(null)

    fun attach(bus: EventBus) {
        val sub = bus.subscribe { event ->
            val summary = FuranEventSummary.from(event)
            synchronized(deque) {
                if (deque.size >= capacity) deque.pollFirst()
                deque.addLast(summary)
            }
        }
        subscription.set(sub)
    }

    fun detach() {
        subscription.getAndSet(null)?.cancel()
    }

    fun snapshot(): List<FuranEventSummary> = synchronized(deque) {
        deque.toList()
    }

    companion object {
        const val DEFAULT_CAPACITY: Int = 64
    }
}
