package io.furan.sdk.auth

/** Builds the `Authorization: Bearer <token>` header value for furan PATs. */
fun bearerHeader(apiToken: String): String {
    require(apiToken.isNotBlank()) { "apiToken must be non-blank" }
    return "Bearer $apiToken"
}
