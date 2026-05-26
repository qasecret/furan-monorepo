package io.furan.sdk.endpoint

/**
 * Pluggable URL resolution for an SDK request. Implementations range
 * from trivial ([StaticEndpointResolver]) to network-aware
 * (region-latency probes, Consul lookups). The contract is `suspend`
 * so future impls can perform I/O without breaking the signature.
 *
 * Composition pattern: decorators (like [FailoverEndpointResolver])
 * wrap an inner resolver and adjust its output based on observed
 * failures. The typical production chain wraps Static or a discovery
 * resolver with Failover.
 */
interface EndpointResolver {
    /**
     * Return the endpoint the caller should hit, given a [hint] that
     * can scope the result by region / tenant / target service.
     */
    suspend fun resolve(hint: EndpointHint = EndpointHint()): ResolvedEndpoint
}
