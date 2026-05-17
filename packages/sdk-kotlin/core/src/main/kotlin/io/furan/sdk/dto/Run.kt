package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * Request body for POST /api/v1/runs (added in Task 4).
 * Mirrors the shape implied by `test_runs` columns in
 * `packages/db/src/schema/test_runs.ts`. Task 4 implements the route to accept this shape.
 */
@Serializable
data class CreateRunRequest(
    val projectId: String,
    val buildId: String,
    val branchName: String,
    val name: String,
    val testVariationId: String? = null,
    val browser: String? = null,
    val device: String? = null,
    val os: String? = null,
    val viewport: String? = null, // "1280x720"
    val customTags: String? = null,
)

/**
 * Response body for POST /api/v1/runs (added in Task 4).
 * Mirrors a `test_runs` row.
 */
@Serializable
data class RunResponse(
    val id: String,
    val projectId: String,
    val buildId: String,
    val testVariationId: String? = null,
    val branchName: String? = null,
    val name: String? = null,
    val status: String? = null,
    val browser: String? = null,
    val device: String? = null,
    val os: String? = null,
    val viewport: String? = null,
    val environment: String = "default",
    val createdAt: String? = null,
)
