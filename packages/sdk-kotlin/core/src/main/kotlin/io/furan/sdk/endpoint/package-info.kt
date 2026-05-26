/**
 * Pluggable endpoint resolution for the Furan SDK.
 *
 * ## Entry points
 *  - [EndpointResolver] — the abstraction every resolver implements.
 *  - [EndpointHint] — caller-supplied region / tenant / service scope.
 *  - [ResolvedEndpoint] — the result: primary URL, fallbacks, ttl,
 *    diagnostic source label.
 *
 * ## Built-in resolvers
 *  - [StaticEndpointResolver] — returns a configured URL on every
 *    call. The right default for single-region installs and tests.
 *  - [FailoverEndpointResolver] — decorator. Wraps an inner resolver
 *    and tracks failure marks via [FailoverEndpointResolver.markFailed].
 *    Demotes failing endpoints for a configurable window, then
 *    auto-recovers.
 *
 * ## Composing a resolver chain
 *
 * The typical production chain wraps a discovery resolver in Failover:
 *
 * ```kotlin
 * val resolver = FailoverEndpointResolver(
 *     inner = StaticEndpointResolver(
 *         primary = "https://api.example.com",
 *         fallbacks = listOf("https://api-eu.example.com"),
 *     ),
 * )
 * ```
 *
 * Or declaratively via [io.furan.sdk.runtime.FuranBootstrapper]:
 *
 * ```kotlin
 * val rt = FuranBootstrapper(
 *     endpointConfig = EndpointResolutionConfig(
 *         primary = "https://api.example.com",
 *         fallbacks = listOf("https://api-eu.example.com"),
 *     ),
 * ).bootstrap()
 * ```
 *
 * ## What's NOT in this phase
 *  - `RegionAwareEndpointResolver` (latency-probe selection) — needs
 *    transport abstraction to ping endpoints; deferred to Phase 3.5 /
 *    Phase 7.
 *  - `K8sHeadlessServiceResolver`, `ConsulEndpointResolver` —
 *    discovery-based resolvers; deferred to Phase 4 (Plugin Registry).
 *  - HTTP transport wiring — the transport doesn't yet consume the
 *    resolver. Deferred to Phase 3.5 which extracts the
 *    `HttpTransport` interface from the current Ktor-coupled class.
 *  - `EventBus` integration — `FailoverEndpointResolver` exposes a
 *    manual `markFailed()` for now; Phase 3.5 will subscribe to an
 *    `EndpointFailedEvent` published by the transport on 5xx.
 */
package io.furan.sdk.endpoint
