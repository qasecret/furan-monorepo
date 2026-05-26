package io.furan.sdk.diagnostics

import io.furan.sdk.event.FuranEvent
import java.time.Instant

/**
 * Compact, non-generic view of a [FuranEvent] suitable for the
 * recent-events ring buffer in [RuntimeSnapshot]. Holds the event's
 * simple class name, its timestamp + correlation id, and a one-line
 * `toString()`-derived description.
 */
data class FuranEventSummary(
    val typeName: String,
    val timestamp: Instant,
    val correlationId: String?,
    val description: String,
) {
    companion object {
        fun from(event: FuranEvent): FuranEventSummary = FuranEventSummary(
            typeName = event::class.java.simpleName ?: event::class.java.name,
            timestamp = event.timestamp,
            correlationId = event.correlationId,
            description = event.toString(),
        )
    }
}
