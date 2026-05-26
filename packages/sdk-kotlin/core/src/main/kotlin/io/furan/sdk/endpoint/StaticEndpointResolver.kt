package io.furan.sdk.endpoint

import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * Trivial resolver — returns the same `ResolvedEndpoint` for every
 * call. The right default for single-region installs and unit tests.
 *
 * Construction validates eagerly so misconfiguration surfaces at
 * bootstrap time rather than the first request.
 */
class StaticEndpointResolver(
    private val primary: String,
    private val fallbacks: List<String> = emptyList(),
    private val ttl: Duration = 5.minutes,
) : EndpointResolver {

    init {
        require(primary.isNotBlank()) { "StaticEndpointResolver.primary must not be blank" }
        require(ttl > Duration.ZERO) { "StaticEndpointResolver.ttl must be > 0" }
    }

    private val resolved = ResolvedEndpoint(
        primary = primary,
        fallbacks = fallbacks,
        ttl = ttl,
        source = SOURCE,
    )

    override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint = resolved

    private companion object {
        const val SOURCE: String = "static"
    }
}
