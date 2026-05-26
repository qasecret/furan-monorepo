package io.furan.sdk.http

/**
 * Request envelope passed to [HttpTransport.execute].
 *
 *  - [method]  — HTTP verb.
 *  - [url]     — absolute URL string. Resolution of relative paths
 *                against a base URL is the caller's concern (the
 *                transport doesn't do path arithmetic).
 *  - [headers] — header name → value. Single-valued; if a header
 *                needs multiple values, the caller joins them.
 *  - [body]    — request body, or `null` for bodyless requests
 *                (GET, HEAD, DELETE without body).
 *
 * Construction validates the URL is non-blank.
 */
data class HttpRequest(
    val method: HttpMethod,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: HttpBody? = null,
) {
    init {
        require(url.isNotBlank()) { "HttpRequest.url must not be blank" }
    }
}
