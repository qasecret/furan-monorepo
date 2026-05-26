package io.furan.sdk.endpoint

/**
 * Channel for callers to report endpoint failures back into the
 * resolver chain. Decoupled from [EndpointResolver] so the same
 * concrete type ([FailoverEndpointResolver]) can implement BOTH
 * interfaces while consumers depend only on the narrower contract
 * they need.
 *
 * The HTTP transport (Phase 3.5+) will call [markFailed] on receiving
 * a 5xx / network error from a request that used the resolver's
 * `primary`. The Failover decorator then demotes that URL for its
 * configured demote window.
 *
 * Implementations should be idempotent: a repeated `markFailed(url)`
 * for the same url either no-ops or refreshes the demote window.
 * Unknown URLs are silently accepted (callers may pass stale URLs).
 */
fun interface EndpointFeedback {
    /** Report that [url] failed and should be demoted from the
     *  active rotation. */
    fun markFailed(url: String)
}
