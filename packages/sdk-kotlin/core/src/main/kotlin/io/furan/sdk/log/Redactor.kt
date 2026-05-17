package io.furan.sdk.log

private val TOKEN_PATTERN = Regex("furan_pat_[A-Za-z0-9]{20,}")
// Match the entire Authorization header value through end-of-line so multi-token
// schemes (e.g., `Bearer xyz`) are fully redacted, not just the first word.
private val AUTH_HEADER = Regex("(?i)Authorization:[^\\r\\n]*")

fun redact(input: String): String =
    input
        .replace(TOKEN_PATTERN, "[REDACTED]")
        .replace(AUTH_HEADER, "Authorization: [REDACTED]")
