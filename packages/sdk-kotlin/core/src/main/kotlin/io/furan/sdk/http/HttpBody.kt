package io.furan.sdk.http

/**
 * The body of an [HttpRequest] or [io.furan.sdk.http.HttpResponse].
 *
 *  - [Empty]       — no body. Default for GET/HEAD/DELETE.
 *  - [Bytes]       — raw byte payload (uploads, binary downloads)
 *                    with explicit content type.
 *  - [JsonString]  — pre-serialized JSON string. The caller
 *                    serializes via `kotlinx.serialization` (or
 *                    any other mechanism) and the transport sends
 *                    the bytes as-is with `Content-Type:
 *                    application/json`.
 *
 * Phase 3.5 intentionally does NOT include a `MultipartFormData`
 * variant — multipart upload handling stays in the legacy
 * `class HttpTransport` until a focused refactor lands the
 * abstraction. The Phase 3.5 SPI covers JSON request/response
 * exchanges, which is the majority of SDK traffic.
 */
sealed class HttpBody {
    /** No body. */
    object Empty : HttpBody()

    /** Raw byte payload with content type. Equals uses
     *  [ByteArray.contentEquals]; the generated data-class equals
     *  is overridden below because the default compares ByteArray
     *  by reference, not content. */
    data class Bytes(val bytes: ByteArray, val contentType: String) : HttpBody() {
        init {
            require(contentType.isNotBlank()) {
                "HttpBody.Bytes.contentType must not be blank"
            }
        }

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Bytes) return false
            return contentType == other.contentType && bytes.contentEquals(other.bytes)
        }

        override fun hashCode(): Int {
            var result = bytes.contentHashCode()
            result = 31 * result + contentType.hashCode()
            return result
        }
    }

    /** Pre-serialized JSON string. Sent with
     *  `Content-Type: application/json`. */
    data class JsonString(val json: String) : HttpBody()
}
