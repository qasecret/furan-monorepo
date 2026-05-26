/**
 * Pluggable endpoint resolution for the Furan SDK.
 *
 * ## Entry points
 *  - [EndpointResolver] — the abstraction every resolver implements.
 *  - [EndpointHint] — caller-supplied region / tenant / service scope.
 *  - [ResolvedEndpoint] — the result: primary URL, fallbacks, ttl,
 *    diagnostic source label.
 *  - [EndpointFeedback] — channel for transports to signal endpoint
 *    failures back into the chain (consumed by [FailoverEndpointResolver]).
 *
 * ## Built-in resolvers
 *  - [StaticEndpointResolver] — returns a configured URL on every
 *    call. The right default for single-region installs and tests.
 *  - [FailoverEndpointResolver] — decorator. Wraps an inner resolver
 *    and tracks failure marks via [FailoverEndpointResolver.markFailed].
 *    Demotes failing endpoints for a configurable window, then
 *    auto-recovers.
 *  - [WeightedEndpointResolver] — weighted random selection from a
 *    list of [WeightedEndpoint] candidates. Use for static traffic
 *    splits (e.g. 70% US / 30% EU).
 *  - [CanaryEndpointResolver] — decorator. Splits traffic between a
 *    stable resolver and a canary resolver by a `canaryFraction`,
 *    with optional sticky-by-key consistent hashing so a tenant
 *    sees a stable rollout decision.
 *  - [TenantAffinityResolver] — consistent-hash routing on
 *    `EndpointHint.tenantId` to a pool of branches; each tenant
 *    always lands on the same shard.
 *
 * ## Composing a resolver chain
 *
 * Typical production stack: `Failover(Canary(Weighted(...)))` —
 * weighted base for traffic shaping, canary on top for rollouts,
 * failover wrapping the lot so demoted endpoints fall through.
 *
 * Declaratively via [io.furan.sdk.runtime.FuranBootstrapper] for
 * Static + Failover; the Phase 7 resolvers are wired by hand:
 *
 * ```kotlin
 * val resolver = FailoverEndpointResolver(
 *     inner = CanaryEndpointResolver(
 *         stable = StaticEndpointResolver(primary = "https://api-prod.example.com"),
 *         canary = StaticEndpointResolver(primary = "https://api-canary.example.com"),
 *         canaryFraction = 0.05,
 *         stickyBy = { it.tenantId },
 *     ),
 * )
 * ```
 *
 * ## What's NOT in this phase
 *  - `LatencyAwareEndpointResolver` (EWMA-tracked latency selection)
 *    — needs transport observability to record per-request timings;
 *    deferred to Phase 3.5 / Phase 7-completion.
 *  - `K8sHeadlessServiceResolver`, `ConsulEndpointResolver` —
 *    discovery-based resolvers; deferred to a separate Phase 4
 *    extension or dedicated plugin artifacts.
 *  - HTTP transport wiring — the transport doesn't yet consume the
 *    resolver. Deferred to Phase 3.5 which extracts the
 *    `HttpTransport` interface from the current Ktor-coupled class.
 *  - `EventBus` integration for the Failover decorator — manual
 *    `markFailed()` call is the current contract; Phase 3.5 will
 *    subscribe to an `EndpointFailedEvent` published by the
 *    transport on 5xx.
 *  - Declarative config (`EndpointResolutionConfig`) extension for
 *    the Phase 7 resolvers — they're wired by hand today; declarative
 *    config can come when there's a real consumer demand.
 */
package io.furan.sdk.endpoint
