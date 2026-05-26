package io.furan.sdk.http

/**
 * Standard HTTP verbs the SDK transport understands. Mirrors the
 * subset of RFC 9110 methods actually used by the SDK; other verbs
 * (CONNECT, TRACE, OPTIONS) are intentionally omitted because the
 * SDK doesn't issue them.
 */
enum class HttpMethod {
    GET, POST, PUT, DELETE, PATCH, HEAD,
}
