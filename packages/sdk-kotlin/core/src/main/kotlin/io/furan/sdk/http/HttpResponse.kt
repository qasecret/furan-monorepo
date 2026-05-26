package io.furan.sdk.http

/**
 * Response envelope returned from [HttpTransport.execute].
 *
 *  - [statusCode] — HTTP status code (`200`, `404`, `500`, ...).
 *  - [headers]    — response headers. Single-valued; if a header
 *                   has multiple values, they're joined with commas
 *                   per RFC 9110 §5.3.
 *  - [body]       — response body as a `String`. For Phase 3.5,
 *                   binary responses (images, files) are NOT
 *                   supported through this SPI — those still flow
 *                   through the legacy `class HttpTransport`.
 *                   Future phases may add a `body: ByteArray`
 *                   variant or stream-based reading.
 *
 * Convenience accessors [isSuccess] and [isRetriable] cover the
 * common dispatch on status.
 */
data class HttpResponse(
    val statusCode: Int,
    val headers: Map<String, String>,
    val body: String,
) {
    /** True iff [statusCode] is in `[200, 299]`. */
    val isSuccess: Boolean get() = statusCode in 200..299

    /** True iff [statusCode] is retriable — `408`, `429`, or any
     *  `5xx`. Matches the policy used by the legacy
     *  `io.furan.sdk.transport.HttpTransport.RetriableException`. */
    val isRetriable: Boolean get() =
        statusCode == 408 || statusCode == 429 || statusCode in 500..599
}
