package io.furan.sdk.config

import java.time.Instant

/**
 * Marker interface for all events that flow through the (future)
 * Furan SDK event bus. Defined in the config package for Phase 1
 * (only ConfigReloadedEvent exists); Phase 2 will move it to a
 * top-level `io.furan.sdk.event` package with a typealias here for
 * source compatibility.
 *
 * Every event carries a timestamp and an optional correlation id so
 * subscribers can stitch related events together across subsystems.
 */
interface FuranEvent {
    val timestamp: Instant
    val correlationId: String?
}
