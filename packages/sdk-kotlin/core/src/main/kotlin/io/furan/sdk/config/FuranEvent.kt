package io.furan.sdk.config

/**
 * Source-compatibility typealias. The canonical home of `FuranEvent`
 * moved to [io.furan.sdk.event.FuranEvent] in Phase 2; this alias
 * keeps Phase 1 callers (and the still-located-here `ConfigReloadedEvent`)
 * resolving without a breaking import change.
 *
 * Prefer `io.furan.sdk.event.FuranEvent` in new code.
 */
@Deprecated(
    "Moved to io.furan.sdk.event.FuranEvent",
    ReplaceWith("FuranEvent", "io.furan.sdk.event.FuranEvent"),
)
typealias FuranEvent = io.furan.sdk.event.FuranEvent
