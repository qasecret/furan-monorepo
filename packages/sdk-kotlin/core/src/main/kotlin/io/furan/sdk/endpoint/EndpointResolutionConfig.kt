package io.furan.sdk.endpoint

import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * Configuration record consumed by [io.furan.sdk.runtime.FuranBootstrapper]
 * to build an [EndpointResolver] chain. Lives as a sibling to the
 * resolver classes so callers can declare endpoint resolution from
 * config rather than constructing resolver instances by hand.
 *
 *  - [primary]              — primary URL; `null` means "no resolver
 *                             will be built" (bootstrap leaves
 *                             `runtime.endpointResolver = null`).
 *  - [fallbacks]            — additional URLs to try after [primary].
 *  - [ttl]                  — re-resolve window for the inner Static
 *                             resolver; default 5 minutes.
 *  - [failoverEnabled]      — when `true` (default), the bootstrapper
 *                             wraps the Static resolver in a
 *                             [FailoverEndpointResolver]. When `false`,
 *                             returns the Static resolver directly.
 *  - [failoverDemoteWindow] — how long the Failover decorator demotes
 *                             a failed endpoint; default 30 seconds.
 */
data class EndpointResolutionConfig(
    val primary: String? = null,
    val fallbacks: List<String> = emptyList(),
    val ttl: Duration = 5.minutes,
    val failoverEnabled: Boolean = true,
    val failoverDemoteWindow: Duration = 30.seconds,
) {
    init {
        require(ttl > Duration.ZERO) {
            "EndpointResolutionConfig.ttl must be > 0"
        }
        require(failoverDemoteWindow > Duration.ZERO) {
            "EndpointResolutionConfig.failoverDemoteWindow must be > 0"
        }
    }
}
