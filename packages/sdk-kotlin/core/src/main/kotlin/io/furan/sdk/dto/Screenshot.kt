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
 * actual upload is multipart (PNG bytes + optional DOM HTML + optional
 * elementMapJson sidecar) via the API screenshots route.
 *
 * `runId` is carried per-snapshot so the Batch can mix uploads from multiple
 * runs (concurrent `Furan(driver).snapshot(...)` across distinct runs land in
 * the same buffer and each flushes to its own `POST /runs/{runId}/screenshots`).
 *
 * `elementMapJson` is the JSON envelope produced by ELEMENT_BBOX_SCRIPT.
 * Null when capture failed, exceeded the SDK-side 1 MB ceiling, or the
 * driver was not a JavascriptExecutor.
 */
data class Snapshot(
    val name: String,
    val viewport: Viewport,
    val pngBytes: ByteArray,
    val domHtml: String? = null,
    val elementMapJson: String? = null,
    val mask: List<String> = emptyList(),
    val browser: String? = null,
    val runId: String? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Snapshot) return false
        return name == other.name &&
            viewport == other.viewport &&
            pngBytes.contentEquals(other.pngBytes) &&
            runId == other.runId
    }

    override fun hashCode(): Int {
        var result = name.hashCode()
        result = 31 * result + viewport.hashCode()
        result = 31 * result + pngBytes.contentHashCode()
        result = 31 * result + (runId?.hashCode() ?: 0)
        return result
    }
}
