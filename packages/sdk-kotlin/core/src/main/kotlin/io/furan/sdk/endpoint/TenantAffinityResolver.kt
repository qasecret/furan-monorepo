package io.furan.sdk.endpoint

/**
 * Routes each [EndpointHint] to a specific branch of a [pool] based
 * on the hint's `tenantId`, using a consistent hash so the same
 * tenant always lands on the same branch. The right shape for a
 * multi-tenant SaaS where each tenant should keep affinity to a
 * stable shard (cache locality, sticky session state, audit trail
 * locality).
 *
 * When the hint has no `tenantId` (a control-plane request, for
 * instance), routing falls through to [defaultBranch]. By default,
 * that's the first entry in [pool]; callers can override for an
 * explicit catch-all (e.g. a dedicated "untagged" shard).
 *
 * The decorated `source` field wraps the inner resolver's source:
 * `"tenant[<inner.source>]"` — preserves provenance through chains.
 *
 * Hash function: splitmix64 finalizer over `tenantId.hashCode()`.
 * The avalanche step ensures sequential tenant ids (`"tenant-1"`,
 * `"tenant-2"`, …) distribute across the pool rather than clustering.
 */
class TenantAffinityResolver(
    private val pool: List<EndpointResolver>,
    private val defaultBranch: EndpointResolver = run {
        require(pool.isNotEmpty()) {
            "TenantAffinityResolver.pool must not be empty"
        }
        pool.first()
    },
) : EndpointResolver {

    init {
        require(pool.isNotEmpty()) {
            "TenantAffinityResolver.pool must not be empty"
        }
    }

    override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint {
        val tenant = hint.tenantId
        val branch = if (tenant != null) {
            val idx = ((mixHash(tenant) and Long.MAX_VALUE) % pool.size).toInt()
            pool[idx]
        } else {
            defaultBranch
        }
        val r = branch.resolve(hint)
        return r.copy(source = "$SOURCE_PREFIX[${r.source}]")
    }

    /**
     * splitmix64 finalizer applied to `key.hashCode()`. Same pattern
     * used by [CanaryEndpointResolver] — avalanches the input bits
     * so sequential keys distribute well across the modulo space.
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
        const val SOURCE_PREFIX: String = "tenant"
    }
}
