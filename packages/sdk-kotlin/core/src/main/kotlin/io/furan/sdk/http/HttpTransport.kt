package io.furan.sdk.http

/**
 * Pluggable HTTP transport for the Furan SDK runtime. The default
 * impl is [KtorHttpTransport]; alternative impls (instrumented
 * transports, in-memory test doubles, mock-server adapters) implement
 * this interface to slot into the runtime.
 *
 * Contract:
 *  - [execute] is a `suspend` function — implementations may perform
 *    network I/O, async retries, etc. The caller is responsible for
 *    setting up coroutine context and timeouts.
 *  - The interface returns an [HttpResponse] for ANY HTTP status
 *    code; non-2xx codes are NOT thrown. Callers dispatch on
 *    [HttpResponse.isSuccess] / [HttpResponse.isRetriable].
 *  - Network failures (DNS, connect, socket reset) DO throw —
 *    typically `IOException` or a transport-specific subclass.
 *    Implementations document their own exception surface.
 *
 * Resource lifecycle: implementations may hold connection pools,
 * coroutine scopes, or other native resources. [close] releases
 * them; the SDK runtime calls it from
 * `FuranRuntime.close()` when the runtime is shut down.
 *
 * Phase 3.5 ships the abstraction; future phases will integrate it
 * with the legacy `class FuranClient` and the existing
 * `io.furan.sdk.transport.HttpTransport` concrete class (which
 * remains the production code path for now).
 */
interface HttpTransport : AutoCloseable {
    suspend fun execute(request: HttpRequest): HttpResponse
}
