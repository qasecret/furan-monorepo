package io.furan.sdk.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Canonical API error envelope. Mirrors the
 * `{ code: string, message: string, statusCode: number, details?: unknown }`
 * shape returned by Fastify routes in `apps/api/src/routes/`
 * (e.g., `{ code: "invalid_body", message: "...", statusCode: 400 }`).
 *
 * `code` is the stable machine-readable error identifier (was `error` in the
 * pre-envelope shape). `details` is deliberately typed as a tolerant nullable
 * [JsonElement] so the untyped `details?: unknown` field never fails to
 * deserialize regardless of its runtime shape.
 */
@Serializable
data class ErrorResponse(
    val code: String,
    val message: String = "",
    val statusCode: Int? = null,
    val details: JsonElement? = null,
)
