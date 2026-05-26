package io.furan.sdk.endpoint

import kotlin.random.Random

/**
 * Decorator that splits traffic between a [stable] endpoint resolver
 * and a [canary] one. [canaryFraction] is the proportion of requests
 * routed to the canary, in `[0.0, 1.0]`. A value of `0.0` always
 * returns stable; `1.0` always returns canary; `0.3` routes ~30% to
 * canary.
 *
 * Sticky routing: if [stickyBy] is supplied, it extracts a key from
 * the [EndpointHint]. The same key always routes the same way (via
 * a consistent hash bucket), so a given tenant or session sees a
 * consistent rollout state. Returning `null` from [stickyBy] (e.g.
 * for a hint without `tenantId`) falls back to the random path.
 *
 * The decorated `source` field wraps the inner resolver's source:
 * `"canary[<inner.source>]"` — preserves provenance through chains.
 *
 * For production use: typically wrap each side ([stable] / [canary])
 * in [FailoverEndpointResolver] so a failing canary degrades back
 * to stable rather than dropping requests.
 */
class CanaryEndpointResolver(
    private val stable: EndpointResolver,
    private val canary: EndpointResolver,
    private val canaryFraction: Double,
    private val stickyBy: ((EndpointHint) -> String?)? = null,
    private val random: Random = Random.Default,
) : EndpointResolver {

    init {
        require(canaryFraction in 0.0..1.0) {
            "CanaryEndpointResolver.canaryFraction must be in [0.0, 1.0] (got $canaryFraction)"
        }
    }

    override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint {
        val key = stickyBy?.invoke(hint)
        val toCanary = if (key != null) {
            // Consistent hash: same key → same bucket → same decision.
            // String.hashCode() distributes sequential keys (e.g.
            // "tenant-1"…"tenant-200") unevenly, so we run a
            // splitmix64-style finalizer over the bits to avalanche
            // them before bucketing.
            val bucket = (mixHash(key) and Long.MAX_VALUE) % BUCKET_RESOLUTION
            bucket < (canaryFraction * BUCKET_RESOLUTION).toLong()
        } else {
            random.nextDouble() < canaryFraction
        }
        val inner = if (toCanary) canary else stable
        val r = inner.resolve(hint)
        return r.copy(source = "$SOURCE_PREFIX[${r.source}]")
    }

    /**
     * splitmix64 finalizer applied to `key.hashCode()`. The two
     * 64-bit multiplies + xor-shifts avalanche the input bits so
     * that sequential keys (`"tenant-1"`, `"tenant-2"`, …) produce
     * well-distributed outputs. Used for consistent-hash bucketing
     * in [resolve].
     */
    private fun mixHash(key: String): Long {
        var h: Long = key.hashCode().toLong()
        h = h xor (h ushr 30)
        h *= -0x40a7b892e9d3a049L  // 0xbf58476d1ce4e5b9
        h = h xor (h ushr 27)
        h *= -0x6b2fb644ecceee15L  // 0x94d049bb133111eb
        h = h xor (h ushr 31)
        return h
    }

    private companion object {
        const val SOURCE_PREFIX: String = "canary"
        /** 10000 = 0.01% precision. */
        const val BUCKET_RESOLUTION: Int = 10000
    }
}
