package io.furan.sdk.transport

import kotlinx.coroutines.delay
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

data class RetryPolicy(
    val maxAttempts: Int = 5,
    val baseDelayMs: Long = 500,
    val maxDelayMs: Long = 30_000,
    val jitter: Double = 0.25,
)

/**
 * Internal transport signal that a request should be retried (5xx / 408 /
 * 429). Caught by [withRetry] within the retry budget; if retries are
 * exhausted, the loop re-throws as-is. User code shouldn't see this
 * directly — wrap before bubbling up to a public boundary (see
 * `FuranClient.postOrThrow` / `getOrThrow`).
 *
 * Extends [io.furan.sdk.FuranTransportException] so a leaked instance
 * still satisfies the "catch FuranException" contract.
 */
class RetriableException(message: String, cause: Throwable? = null) :
    io.furan.sdk.FuranTransportException(
        statusCode = null,
        responseBody = null,
        message = message,
        cause = cause,
    )

suspend fun <T> withRetry(
    policy: RetryPolicy = RetryPolicy(),
    isRetriable: (Throwable) -> Boolean = { it is RetriableException },
    block: suspend (attempt: Int) -> T,
): T {
    var lastError: Throwable? = null
    for (attempt in 1..policy.maxAttempts) {
        try {
            return block(attempt)
        } catch (e: Throwable) {
            lastError = e
            if (!isRetriable(e) || attempt == policy.maxAttempts) throw e
            val expDelay = (policy.baseDelayMs * 2.0.pow(attempt - 1)).toLong()
            val capped = min(expDelay, policy.maxDelayMs)
            val jitterFactor = 1 + (Random.nextDouble() - 0.5) * 2 * policy.jitter
            val jittered = (capped * jitterFactor).toLong().coerceAtLeast(0)
            delay(jittered)
        }
    }
    throw lastError ?: IllegalStateException("retry loop exited without result")
}
