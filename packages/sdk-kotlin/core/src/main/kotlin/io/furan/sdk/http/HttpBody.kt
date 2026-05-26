package io.furan.sdk.http

/**
 * Sealed marker for HTTP body shapes. Subtypes are added in
 * a later task (P3.5.2): [HttpBody.Empty], [HttpBody.Bytes],
 * [HttpBody.JsonString]. Phase 3.5 does not include multipart
 * upload — that's intentional; the legacy `class HttpTransport`
 * still handles multipart via direct Ktor access until a later
 * refactor lands a `MultipartFormData` variant.
 */
sealed class HttpBody
