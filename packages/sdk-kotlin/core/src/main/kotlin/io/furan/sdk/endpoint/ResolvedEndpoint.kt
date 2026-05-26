package io.furan.sdk.endpoint

import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * The output of [EndpointResolver.resolve]. Carries the primary URL
 * the caller should hit, optional fallbacks (for client-side retry
 * loops to walk if the primary is down), a TTL after which the caller
 * should re-resolve, and a diagnostic source label.
 *
 *  - [primary]   — URL string the caller should use first.
 *  - [fallbacks] — additional URLs to try in order if [primary] fails.
 *  - [ttl]       — re-resolve after this duration. Default 5 minutes.
 *  - [source]    — diagnostic label (`"static"`, `"failover"`,
 *                  `"consul"`, ...) for [io.furan.sdk.config.ConfigValue]-style
 *                  provenance.
 */
data class ResolvedEndpoint(
    val primary: String,
    val fallbacks: List<String> = emptyList(),
    val ttl: Duration = 5.minutes,
    val source: String,
)
