package io.furan.sdk.dto

import io.furan.sdk.Viewport
import kotlinx.serialization.Serializable

/**
 * Response body for POST /api/v1/runs/:runId/screenshots (added in Task 4).
 * Mirrors the `screenshots` Drizzle row in `packages/db/src/schema/screenshots.ts`.
 */
@Serializable
data class ScreenshotResponse(
    val id: String,
    val runId: String,
    val projectId: String,
    val imageKey: String,
    val domKey: String? = null,
    val viewport: String,
    val browser: String,
    val createdAt: String? = null,
)

/**
 * Internal SDK shape representing a captured snapshot prior to upload.
 * NOT serialized over the wire — used as the buffered Batch element. The
 * eventual upload is multipart (PNG bytes + optional DOM HTML) via Task 4's route.
 */
data class Snapshot(
    val name: String,
    val viewport: Viewport,
    val pngBytes: ByteArray,
    val domHtml: String? = null,
    val mask: List<String> = emptyList(),
    val browser: String? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Snapshot) return false
        return name == other.name &&
            viewport == other.viewport &&
            pngBytes.contentEquals(other.pngBytes)
    }

    override fun hashCode(): Int =
        (name.hashCode() * 31 + viewport.hashCode()) * 31 + pngBytes.contentHashCode()
}
