package io.furan.sdk.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Standard API error response. Mirrors the `{ error: string }` shape returned
 * by Fastify routes in `apps/api/src/routes/` (e.g., `{ error: "invalid_body" }`).
 * `message` and `details` are optional fields some routes include for richer errors.
 */
@Serializable
data class ErrorResponse(
    val error: String,
    val message: String? = null,
    val details: Map<String, JsonElement>? = null,
)
