package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * Request body for POST /runs. Mirrors the shape implied by `test_runs`
 * columns in `packages/db/src/schema/test_runs.ts`.
 *
 * `diffTolerance` + `ignoreAreas` are per-run overrides the diff worker
 * applies on the first diff job — no separate `setIgnoreAreas` /
 * `setDiffThresholdOverride` round-trip needed. Matches the legacy
 * Java SDK's `TestRunRequest` shape (`diffTollerancePercent` +
 * `ignoreAreas`).
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
    /**
     * 0.0–1.0 fraction (e.g. 0.005 = 0.5%). When set, the diff worker
     * uses this instead of the project default. Out-of-range values are
     * 400 server-side.
     */
    val diffTolerance: Double? = null,
    /**
     * Per-run ignore regions. Capped at 50 entries server-side
     * (matches the dashboard's `MAX_IGNORE_REGIONS`). Subsequent
     * tweaks go through tRPC `runs.setIgnoreAreas`.
     */
    val ignoreAreas: List<IgnoreArea>? = null,
)

/**
 * Response body for POST /runs and GET /runs/{id}. Mirrors a `test_runs` row.
 *
 * `status` is decoded via [RunStatus.TolerantSerializer] — unknown wire
 * values fall back to [RunStatus.UNRESOLVED] so a server that adds new
 * statuses does not break old SDK clients.
 */
@Serializable
data class RunResponse(
    val id: String,
    val projectId: String,
    val buildId: String,
    val testVariationId: String? = null,
    val branchName: String? = null,
    val name: String? = null,
    val status: RunStatus? = null,
    val browser: String? = null,
    val device: String? = null,
    val os: String? = null,
    val viewport: String? = null,
    val environment: String = "default",
    val createdAt: String? = null,
    /**
     * Diff percentage as reported by the diff worker on a terminal run.
     * Null while the run is still `new`/`running`. Surfaced on
     * [io.furan.sdk.dto.SnapshotResult] for assertion-friendly access.
     */
    val diffPercent: Double? = null,
    /**
     * True when the run's screenshot bytes matched the baseline pixel-for-
     * pixel and the diff worker auto-approved it (ADR-032). The user did
     * not have to review.
     */
    val autoApproved: Boolean? = null,
    /**
     * Where the baseline used for this diff came from — `this_branch`,
     * `main_fallback`, `auto`, etc. Useful in test assertions that care
     * about branch-isolation correctness.
     */
    val baselineSource: String? = null,
)
