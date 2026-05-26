/**
 * HTTP transport abstraction for the Furan SDK runtime.
 *
 * ## Entry points
 *  - [HttpTransport] — interface every transport implements.
 *  - [KtorHttpTransport] — default Ktor-CIO-backed impl. Accepts
 *    an optional `engine` override so tests can swap in
 *    `io.ktor.client.engine.mock.MockEngine` without spinning up
 *    a real network stack.
 *  - [HttpRequest] — request envelope (method, url, headers, body).
 *  - [HttpResponse] — response envelope (status, headers, body)
 *    with [HttpResponse.isSuccess] and [HttpResponse.isRetriable]
 *    convenience accessors.
 *  - [HttpBody] — sealed body type: `Empty`, `Bytes`, `JsonString`.
 *  - [HttpMethod] — enum of standard verbs the SDK uses.
 *
 * ## Wiring
 *
 * The transport is opt-in via [io.furan.sdk.runtime.FuranBootstrapper]:
 *
 * ```kotlin
 * val rt = FuranBootstrapper(
 *     httpTransportFactory = { KtorHttpTransport() },
 * ).bootstrap()
 * val response = rt.httpTransport!!.execute(
 *     HttpRequest(HttpMethod.GET, "https://api.example.com/health")
 * )
 * ```
 *
 * `runtime.close()` calls `httpTransport?.close()` to release
 * connection pools.
 *
 * ## What's NOT in this phase (intentional deferrals)
 *
 *  - **`FuranClient` consumer migration** — the legacy
 *    `io.furan.sdk.transport.HttpTransport` concrete class and
 *    `FuranClient`'s direct Ktor multipart calls are NOT refactored
 *    in this phase. Both code paths coexist: legacy `FuranClient`
 *    uses the old concrete class; the new `HttpTransport` SPI is
 *    available for plugins, the Phase 7-final
 *    `LatencyAwareEndpointResolver`, and a future v1.0 refactor.
 *    Reason: multipart upload + inline-reified `get<T>` / `post<TReq, TRes>`
 *    require careful API design that deserves its own focused PR
 *    with explicit consumer-feedback and likely a major-version
 *    transition.
 *
 *  - **`MultipartFormData` body variant** — multipart upload stays
 *    in the legacy `class HttpTransport` until the consumer
 *    migration above happens. A `HttpBody.Multipart(parts)` variant
 *    will land alongside the `FuranClient` refactor.
 *
 *  - **Binary response bodies** — `HttpResponse.body` is `String`.
 *    For Phase 3.5 traffic (JSON request/response), this is fine.
 *    A `body: ByteArray` variant or streaming reader lands when
 *    there's a real consumer (e.g. snapshot download from the API).
 *
 *  - **Retry / circuit-breaker / interceptor pipeline** — the v2
 *    spec sketches a layered pipeline (Auth, Telemetry, Retry,
 *    Compression, CircuitBreaker). Phase 3.5 ships only the
 *    transport-level abstraction; pipeline composition is a
 *    separate phase that consumers can build on top of (likely
 *    via a `DecoratingHttpTransport` wrapper).
 *
 *  - **`HttpTransport.execute` does NOT throw on non-2xx** — the
 *    caller dispatches on [HttpResponse.statusCode]. Network failures
 *    (DNS, connect, socket reset) DO throw — typically IOException.
 *    This matches the legacy class's `expectSuccess = false`
 *    behavior.
 */
package io.furan.sdk.http
