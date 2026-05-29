package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * Returned by [io.furan.sdk.FuranClient.createScreenshot] — identifies
 * the newly created checkpoint and the test variation it belongs to.
 */
@Serializable
data class CheckpointSubmission(
    val checkpointId: String,
    val testVariationId: String,
)

/**
 * Terminal result for a single checkpoint once the diff worker has
 * processed it. Returned by [io.furan.sdk.FuranClient.awaitCheckpoint]
 * and carried inside [RunResult.checkpoints].
 */
@Serializable
data class CheckpointResult(
    val checkpointId: String,
    val name: String,
    val status: RunStatus,
    val diffPercent: Double? = null,
    val diffViewerUrl: String? = null,
)

/**
 * Terminal result for an entire run, returned by
 * [io.furan.sdk.FuranClient.completeRun] and
 * [io.furan.sdk.selenium.Furan.close].
 */
@Serializable
data class RunResult(
    val runId: String,
    val status: RunStatus,
    val checkpointCount: Int,
    val checkpoints: List<CheckpointResult> = emptyList(),
)
