package io.furan.sdk.http

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod as KtorHttpMethod
import io.ktor.http.contentType

/**
 * Ktor-CIO-backed [HttpTransport] implementation. The default
 * production transport; alternative impls swap this out via the
 * [io.furan.sdk.runtime.FuranBootstrapper] /
 * [io.furan.sdk.runtime.FuranRuntime] wiring.
 *
 * The constructor accepts an optional [HttpClientEngine] override so
 * tests can plug in [io.ktor.client.engine.mock.MockEngine] without
 * spinning up a real network stack. Production passes `null` and
 * gets a [CIO] engine.
 *
 * Resource lifecycle: owns a [HttpClient]. [close] releases it.
 * Idempotent — close-after-close is a no-op (Ktor's own contract).
 */
class KtorHttpTransport(
    engine: HttpClientEngine? = null,
    private val requestTimeoutMillis: Long = DEFAULT_REQUEST_TIMEOUT_MS,
    private val connectTimeoutMillis: Long = DEFAULT_CONNECT_TIMEOUT_MS,
) : HttpTransport {

    private val client: HttpClient = if (engine != null) {
        HttpClient(engine) {
            expectSuccess = false
            install(HttpTimeout) {
                requestTimeoutMillis = this@KtorHttpTransport.requestTimeoutMillis
                connectTimeoutMillis = this@KtorHttpTransport.connectTimeoutMillis
            }
        }
    } else {
        HttpClient(CIO) {
            expectSuccess = false
            install(HttpTimeout) {
                requestTimeoutMillis = this@KtorHttpTransport.requestTimeoutMillis
                connectTimeoutMillis = this@KtorHttpTransport.connectTimeoutMillis
            }
        }
    }

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val ktorResponse = client.request(request.url) {
            method = request.method.toKtor()
            request.headers.forEach { (name, value) -> header(name, value) }
            when (val body = request.body) {
                null, HttpBody.Empty -> { /* no body */ }
                is HttpBody.Bytes -> {
                    setBody(body.bytes)
                    contentType(ContentType.parse(body.contentType))
                }
                is HttpBody.JsonString -> {
                    setBody(body.json)
                    contentType(ContentType.Application.Json)
                }
            }
        }
        val responseBody = ktorResponse.bodyAsText()
        val responseHeaders: Map<String, String> = ktorResponse.headers.entries()
            .associate { (name, values) -> name to values.joinToString(",") }
        return HttpResponse(
            statusCode = ktorResponse.status.value,
            headers = responseHeaders,
            body = responseBody,
        )
    }

    override fun close() {
        client.close()
    }

    private fun HttpMethod.toKtor(): KtorHttpMethod = when (this) {
        HttpMethod.GET -> KtorHttpMethod.Get
        HttpMethod.POST -> KtorHttpMethod.Post
        HttpMethod.PUT -> KtorHttpMethod.Put
        HttpMethod.DELETE -> KtorHttpMethod.Delete
        HttpMethod.PATCH -> KtorHttpMethod.Patch
        HttpMethod.HEAD -> KtorHttpMethod.Head
    }

    private companion object {
        const val DEFAULT_REQUEST_TIMEOUT_MS: Long = 30_000
        const val DEFAULT_CONNECT_TIMEOUT_MS: Long = 10_000
    }
}
