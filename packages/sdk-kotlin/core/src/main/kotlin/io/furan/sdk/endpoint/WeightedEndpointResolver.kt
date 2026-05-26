package io.furan.sdk.endpoint

import kotlin.random.Random

/**
 * Picks one of several candidates on each call, with the per-call
 * probability proportional to each candidate's [WeightedEndpoint.weight].
 *
 * Use for static traffic splits — e.g. an SDK config that lists
 * `api-us` at weight 70 and `api-eu` at weight 30 will route ~70%
 * of requests to US and ~30% to EU, with no awareness of latency or
 * health (wrap in [FailoverEndpointResolver] for that).
 *
 * The [random] source is injectable so tests can use a seeded
 * `Random` for deterministic sequences. Production uses
 * `Random.Default`.
 *
 * Construction validates eagerly: empty candidate lists throw at
 * construction, not at the first `resolve` call.
 */
class WeightedEndpointResolver(
    private val candidates: List<WeightedEndpoint>,
    private val random: Random = Random.Default,
) : EndpointResolver {

    init {
        require(candidates.isNotEmpty()) {
            "WeightedEndpointResolver.candidates must not be empty"
        }
    }

    private val totalWeight: Int = candidates.sumOf { it.weight }

    override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint {
        val pick = random.nextInt(totalWeight)
        var acc = 0
        for (c in candidates) {
            acc += c.weight
            if (pick < acc) {
                return ResolvedEndpoint(primary = c.url, source = SOURCE)
            }
        }
        // Mathematically unreachable: pick is in [0, totalWeight) and
        // acc reaches totalWeight on the final iteration.
        return ResolvedEndpoint(primary = candidates.last().url, source = SOURCE)
    }

    private companion object {
        const val SOURCE: String = "weighted"
    }
}
