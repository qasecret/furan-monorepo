package io.furan.sdk.event

import java.time.Instant

/**
 * Marker interface for all events that flow through the SDK's
 * [EventBus]. Every event carries a timestamp and an optional
 * correlation id so subscribers can stitch related events together
 * across subsystems (e.g. a `ConfigReloadedEvent` and a subsequent
 * `StateChangedEvent` triggered by the same reload).
 *
 * Events should be small immutable values. Subscribers must NOT
 * mutate event fields and must NOT block on event delivery — the bus
 * uses a bounded buffer with `DROP_OLDEST` overflow.
 */
interface FuranEvent {
    val timestamp: Instant
    val correlationId: String?
}
