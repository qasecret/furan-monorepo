package io.furan.sdk.transport

import io.furan.sdk.FuranConfig
import io.furan.sdk.auth.bearerHeader
import io.furan.sdk.log.redact
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.io.Closeable
import java.util.UUID

/**
 * Ktor-backed HTTP transport for the Furan SDK.
 *
 * Responsibilities:
 *  - Apply Bearer auth on every request via defaultRequest.
 *  - Tag every request with a fresh X-Request-Id for correlation.
 *  - Apply redaction-aware logging when log level is enabled.
 *  - Wrap retriable HTTP failures (5xx, 408, 429) as [RetriableException] so
 *    [withRetry] applies exponential backoff with jitter.
 *  - Decode JSON responses via kotlinx.serialization (Ktor ContentNegotiation).
 *
 * Defensible deviation from the task sketch: uses `response.body()` for
 * auto-deserialization (Ktor 3 idiom) rather than calling the serializer module
 * explicitly. This is cleaner and matches Ktor 3's documented pattern.
 */
class HttpTransport(private val config: FuranConfig) : Closeable {
    private val jsonCodec = Json {
        ignoreUnknownKeys = true
        isLenient = true
        // explicitNulls = false drops nullable fields whose value is null from
        // the serialized JSON. The api's zod request schemas (e.g.
        // `createRunBody` in apps/api/src/routes/sdk-runs.ts, `createBody` in
        // apps/api/src/routes/builds.ts) use `.optional()`, which means
        // `T | undefined` — NOT `T | null`. With the previous
        // `encodeDefaults = true` config, nullable DTO fields holding their
        // default null value (e.g. CreateRunRequest.testVariationId,
        // CreateBuildRequest.ciBuildId) serialized as `"foo": null` and zod
        // rejected the body with 400 invalid_body. Dropping the nulls makes
        // the wire shape match what the api expects.
        //
        // encodeDefaults is intentionally NOT set: every DTO field with a
        // default in packages/sdk-kotlin/core/src/main/kotlin/io/furan/sdk/dto/
        // defaults to null today, so there is no non-null default that needs
        // to round-trip. If a future DTO field needs a load-bearing non-null
        // default (e.g. `val telemetryEnabled: Boolean = true`), set
        // `encodeDefaults = true` here — combined with `explicitNulls = false`
        // it still does the right thing (non-null defaults serialize; null
        // defaults are dropped).
        explicitNulls = false
    }

    val client: HttpClient = HttpClient(CIO) {
        expectSuccess = false
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000
            connectTimeoutMillis = 10_000
            socketTimeoutMillis = 30_000
        }
        install(ContentNegotiation) {
            json(jsonCodec)
        }
        install(Logging) {
            level = when (config.logLevel.lowercase()) {
                "trace" -> LogLevel.ALL
                "debug" -> LogLevel.HEADERS
                "info" -> LogLevel.INFO
                else -> LogLevel.NONE
            }
            logger = object : Logger {
                override fun log(message: String) {
                    // Apply redaction before emitting — defense against
                    // accidentally logging Authorization headers or PATs.
                    println("[furan-sdk] ${redact(message)}")
                }
            }
        }
        defaultRequest {
            url(ensureTrailingSlash(config.apiUrl))
            header(HttpHeaders.Authorization, bearerHeader(config.apiToken))
            header(
                HttpHeaders.UserAgent,
                "furan-sdk-kotlin/$SDK_VERSION (jvm/${System.getProperty("java.version")})",
            )
        }
    }

    /**
     * POST [path] with JSON body [body]; decode response into [TRes].
     * Retries on 5xx, 408, 429 via [RetriableException].
     */
    suspend inline fun <reified TReq, reified TRes : Any> post(
        path: String,
        body: TReq,
    ): TRes = withRetry { _ ->
        val response = client.post(path) {
            header("X-Request-Id", UUID.randomUUID().toString())
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        if (!response.status.isSuccess()) {
            val text = response.bodyAsText()
            val code = response.status.value
            if (code in 500..599 || code == 408 || code == 429) {
                throw RetriableException("HTTP $code: ${redact(text)}")
            }
            throw HttpException(code, text)
        }
        response.body()
    }

    /**
     * GET [path]; decode response into [TRes]. Same retry rules as [post].
     * Backs the polling loop in `FuranClient.snapshotAndAwait()` — see
     * `core/src/main/kotlin/io/furan/sdk/FuranClient.kt`.
     */
    suspend inline fun <reified TRes : Any> get(path: String): TRes = withRetry { _ ->
        val response = client.get(path) {
            header("X-Request-Id", UUID.randomUUID().toString())
        }
        if (!response.status.isSuccess()) {
            val text = response.bodyAsText()
            val code = response.status.value
            if (code in 500..599 || code == 408 || code == 429) {
                throw RetriableException("HTTP $code: ${redact(text)}")
            }
            throw HttpException(code, text)
        }
        response.body()
    }

    override fun close() {
        client.close()
    }

    companion object {
        const val SDK_VERSION = "0.5.0"

        /** Ktor `defaultRequest.url(...)` treats a host-only string as a prefix only
         *  when it ends with `/`. Be forgiving for users who set `FURAN_API_URL`
         *  without a trailing slash. */
        fun ensureTrailingSlash(url: String): String =
            if (url.endsWith("/")) url else "$url/"
    }
}

/** Non-retriable HTTP error (4xx other than 408/429). */
class HttpException(val statusCode: Int, val responseBody: String) :
    RuntimeException("HTTP $statusCode: $responseBody")
