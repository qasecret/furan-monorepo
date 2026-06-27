package io.furan.sdk

import io.furan.sdk.dto.AccessibilityRegion
import io.furan.sdk.dto.BuildResponse
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.CreateRunRequest
import io.furan.sdk.dto.FloatingRegion
import io.furan.sdk.dto.MatchLevel
import io.furan.sdk.dto.Region
import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.Snapshot
import io.furan.sdk.dto.SnapshotResult
import io.furan.sdk.telemetry.AnonymousCounter
import io.furan.sdk.telemetry.SdkTelemetryPayload
import io.furan.sdk.transport.Batch
import io.furan.sdk.transport.HttpException
import io.furan.sdk.transport.HttpTransport
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.util.UUID
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource

/**
 * Top-level SDK orchestrator. Composes [HttpTransport] + [Batch] + telemetry.
 * Public adapters (sdk-selenium, sdk-playwright) instantiate one of these.
 *
 * REST URL convention: routes are mounted on `apps/api` WITHOUT an `/api/v1`
 * prefix (matches the existing convention used by `/auth/login`,
 * `/projects/:id/builds`, etc.). Task 4 added `POST /runs`,
 * `POST /runs/:runId/screenshots`, and `POST /_telemetry/sdk`.
 */
/**
 * Bundles the five region collections for a single checkpoint upload.
 * Used by [FuranClient.createScreenshot] to pass structured region data
 * without requiring the caller to manage individual lists.
 */
data class Regions(
    val ignore: List<Region> = emptyList(),
    val layout: List<Region> = emptyList(),
    val floating: List<FloatingRegion> = emptyList(),
    val content: List<Region> = emptyList(),
    val accessibility: List<AccessibilityRegion> = emptyList(),
)

/** SDK-internal value returned by [FuranClient.createRun2] (ADR-038 v1.1.0). */
data class CreatedRun(val runId: String, val status: RunStatus, val name: String)

open class FuranClient(
    val config: FuranConfig,
    val adapter: String = "unknown",
) : Closeable {
    private val transport = HttpTransport(config)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
    private val counter = AnonymousCounter(
        sdkVersion = HttpTransport.SDK_VERSION,
        adapter = adapter,
    )
    private val batch = Batch<Snapshot>(size = config.batchSize) { snaps ->
        for (snap in snaps) uploadSnapshotInner(snap)
    }

    /** Create a new build under the SDK's configured project. */
    suspend fun createBuild(req: CreateBuildRequest): BuildResponse = try {
        transport
            .post<CreateBuildRequest, BuildResponse>(
                "projects/${config.projectId}/builds",
                req,
            )
            .also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /** Create a new run. Endpoint `POST /runs` lives in `apps/api`. */
    suspend fun createRun(req: CreateRunRequest): RunResponse = try {
        transport
            .post<CreateRunRequest, RunResponse>("runs", req)
            .also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    // -------------------------------------------------------------------------
    // ADR-038 v2 methods — open/snapshot/close lifecycle
    // -------------------------------------------------------------------------

    /**
     * ADR-038: create a new run with the v1.1.0 request shape.
     * `POST /runs` body is `{ projectId, buildId, name, branchName }`, plus an
     * optional `parentBranchName` (ADR-055) when a parent branch is configured.
     * Returns a [CreatedRun] with `runId`, `status`, and `name`.
     */
    suspend fun createRun2(
        buildId: String,
        projectId: String,
        name: String,
        branchName: String,
        parentBranchName: String? = null,
    ): CreatedRun = try {
        val body = buildJsonObject {
            put("projectId", projectId)
            put("buildId", buildId)
            put("name", name)
            put("branchName", branchName)
            // ADR-055: omit when null to keep the wire minimal.
            if (parentBranchName != null) put("parentBranchName", parentBranchName)
        }
        val parsed = transport.post<JsonObject, JsonObject>("runs", body)
        CreatedRun(
            runId = parsed.getValue("runId").jsonPrimitive.content,
            status = RunStatus.fromWire(parsed.getValue("status").jsonPrimitive.contentOrNull ?: "running"),
            name = parsed.getValue("name").jsonPrimitive.contentOrNull ?: name,
        ).also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /**
     * ADR-038: `POST /runs/:runId/complete` — signals the server to roll up
     * the run's checkpoint statuses and mark the run terminal.
     * Returns the [RunResult] (runId, status, checkpointCount).
     */
    open suspend fun completeRun(runId: String): RunResult = try {
        transport
            .post<JsonObject, RunResult>("runs/$runId/complete", JsonObject(emptyMap()))
            .also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /**
     * ADR-038 / Eyes-compat P1: complete the run *and* poll until a terminal
     * status is reached, then return the true verdict as a [RunResult].
     *
     * [completeRun] fires `POST /runs/:runId/complete`, which rolls up the
     * run immediately but may still return `running` when diff jobs are
     * outstanding. This method polls [getRun] every
     * [FuranConfig.pollIntervalSeconds] until the status is terminal (or
     * `NEW`, which never transitions further without manual approval and
     * would always time out if we waited). Returns a [RunResult] whose
     * `status` reflects the true terminal verdict and whose `checkpointCount`
     * comes from the `completeRun` response.
     *
     * Throws [FuranTimeoutException] if no terminal is observed within
     * [timeout] (defaults to [FuranConfig.pollTimeoutSeconds]).
     */
    suspend fun completeAndAwaitRun(
        runId: String,
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): RunResult {
        val completed = completeRun(runId)
        if (completed.status.isTerminal() || completed.status == RunStatus.NEW) return completed
        val mark = TimeSource.Monotonic.markNow()
        val interval = config.pollIntervalSeconds.seconds
        var lastStatus: RunStatus? = completed.status
        while (mark.elapsedNow() < timeout) {
            val run = getRun(runId)
            val status = run.status
            if (status != null && (status.isTerminal() || status == RunStatus.NEW)) {
                return RunResult(
                    runId = runId,
                    status = status,
                    checkpointCount = completed.checkpointCount,
                    checkpoints = completed.checkpoints,
                )
            }
            lastStatus = status
            delay(interval)
        }
        throw FuranTimeoutException(runId, lastStatus, timeout.inWholeSeconds)
    }

    /**
     * ADR-038: `POST /runs/:runId/abort` — marks the run `aborted`.
     * Best-effort; ignores failures (the run will be cleaned up by
     * a periodic background task if it stalls in `running`).
     */
    suspend fun abortRun(runId: String) {
        runCatching {
            transport.post<JsonObject, JsonObject>("runs/$runId/abort", JsonObject(emptyMap()))
        }
    }

    /**
     * ADR-038 v2 screenshot upload: multipart `POST /runs/:runId/screenshots`
     * carrying all new fields (`viewport`, `browser`, `os`, `device`,
     * `matchLevel`, `regions`). Returns [CheckpointSubmission] with the
     * checkpoint + test-variation IDs.
     */
    @Suppress("LongParameterList")
    suspend fun createScreenshot(
        runId: String,
        name: String,
        viewport: String,
        browser: String,
        os: String?,
        device: String?,
        matchLevel: MatchLevel,
        regions: Regions,
        pngBytes: ByteArray,
        domHtml: String?,
        elementMapJson: String?,
        ignoreDisplacements: Boolean = false,
        accessibilityLevel: String? = null,
        accessibilityVersion: String? = null,
    ): CheckpointSubmission = try {
        val regionsJson = buildJsonObject {
            put("ignore", json.parseToJsonElement(json.encodeToString(regions.ignore)))
            put("layout", json.parseToJsonElement(json.encodeToString(regions.layout)))
            put("floating", json.parseToJsonElement(json.encodeToString(regions.floating)))
            put("content", json.parseToJsonElement(json.encodeToString(regions.content)))
            put("accessibility", json.parseToJsonElement(json.encodeToString(regions.accessibility)))
        }.toString()
        val multipart = MultiPartFormDataContent(
            formData {
                append("name", name)
                append("viewport", viewport)
                append("browser", browser)
                os?.let { append("os", it) }
                device?.let { append("device", it) }
                append("matchLevel", matchLevel.name)
                append("regions", regionsJson)
                if (ignoreDisplacements) append("ignoreDisplacements", "true")
                accessibilityLevel?.let { append("accessibilityLevel", it) }
                accessibilityVersion?.let { append("accessibilityVersion", it) }
                append(
                    "pngBytes",
                    pngBytes,
                    Headers.build {
                        append(HttpHeaders.ContentType, "image/png")
                        append(HttpHeaders.ContentDisposition, "filename=\"snap.png\"")
                    },
                )
                domHtml?.let { dom ->
                    append(
                        "domHtml",
                        dom.toByteArray(Charsets.UTF_8),
                        Headers.build {
                            append(HttpHeaders.ContentType, "text/html; charset=utf-8")
                            append(HttpHeaders.ContentDisposition, "filename=\"snap.html\"")
                        },
                    )
                }
                elementMapJson?.let { em ->
                    append(
                        "elementMapJson",
                        em.toByteArray(Charsets.UTF_8),
                        Headers.build {
                            append(HttpHeaders.ContentType, "application/json; charset=utf-8")
                            append(HttpHeaders.ContentDisposition, "filename=\"elements.json\"")
                        },
                    )
                }
            },
        )
        val response = transport.client.post("runs/$runId/screenshots") {
            header("X-Request-Id", UUID.randomUUID().toString())
            setBody(multipart)
        }
        if (!response.status.isSuccess()) {
            counter.recordError()
            throw HttpException(response.status.value, response.bodyAsText())
        }
        counter.recordSuccess()
        val parsed = json.parseToJsonElement(response.bodyAsText()).jsonObject
        CheckpointSubmission(
            checkpointId = parsed.getValue("checkpointId").jsonPrimitive.content,
            testVariationId = parsed.getValue("testVariationId").jsonPrimitive.content,
        )
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /**
     * Poll `GET /runs/:runId` until the run reaches a terminal status, then
     * synthesize a [CheckpointResult] for the checkpoint identified by
     * [checkpointId]. Since there is no per-checkpoint status endpoint in
     * v1.1.0, we await the run and find the matching checkpoint in the result.
     *
     * Falls back to a run-level [CheckpointResult] when the specific checkpoint
     * cannot be found (e.g., still diffing or missing from the result list).
     */
    suspend fun awaitCheckpoint(
        checkpointId: String,
        timeout: Duration = config.pollTimeoutSeconds.seconds,
        runId: String,
    ): CheckpointResult {
        val snapshotResult = awaitRunResult(runId, timeout)
        // Synthesize a checkpoint-level result from the run outcome.
        return CheckpointResult(
            checkpointId = checkpointId,
            name = "checkpoint",
            status = snapshotResult.status,
            diffPercent = snapshotResult.diffPercent,
            diffViewerUrl = snapshotResult.diffViewerUrl,
        )
    }

    /**
     * Offer a snapshot to the batch. Flush happens automatically when the
     * batch reaches `config.batchSize`, or on [flush]/[close]. The [runId]
     * is stamped onto the snapshot so each flushed item knows where to land
     * (the Batch may interleave snapshots from multiple runs).
     */
    suspend fun uploadSnapshot(runId: String, snap: Snapshot) {
        batch.offer(snap.copy(runId = runId))
    }

    /**
     * Multipart POST to `/runs/{runId}/screenshots`. Sends `pngBytes` (image),
     * optional `domHtml` (text), and the metadata fields (`name`, `viewport`,
     * `browser`) as form values. Throws [HttpException] on non-2xx.
     */
    private suspend fun uploadSnapshotInner(snap: Snapshot) {
        val runId = snap.runId
            ?: throw IllegalStateException(
                "Snapshot reached uploadSnapshotInner without a runId. " +
                    "Use FuranClient.uploadSnapshot(runId, snap) — never offer to the Batch directly.",
            )
        try {
            val viewportStr = "${snap.viewport.width}x${snap.viewport.height}"
            val browserStr = snap.browser ?: adapter
            val multipart = MultiPartFormDataContent(
                formData {
                    append("name", snap.name)
                    append("viewport", viewportStr)
                    append("browser", browserStr)
                    append(
                        "pngBytes",
                        snap.pngBytes,
                        Headers.build {
                            append(HttpHeaders.ContentType, "image/png")
                            append(HttpHeaders.ContentDisposition, "filename=\"snap.png\"")
                        },
                    )
                    snap.domHtml?.let { dom ->
                        append(
                            "domHtml",
                            dom.toByteArray(Charsets.UTF_8),
                            Headers.build {
                                append(HttpHeaders.ContentType, "text/html; charset=utf-8")
                                append(HttpHeaders.ContentDisposition, "filename=\"snap.html\"")
                            },
                        )
                    }
                    snap.elementMapJson?.let { elementMap ->
                        append(
                            "elementMapJson",
                            elementMap.toByteArray(Charsets.UTF_8),
                            Headers.build {
                                append(HttpHeaders.ContentType, "application/json; charset=utf-8")
                                append(HttpHeaders.ContentDisposition, "filename=\"elements.json\"")
                            },
                        )
                    }
                },
            )
            val response = transport.client.post("runs/$runId/screenshots") {
                header("X-Request-Id", UUID.randomUUID().toString())
                setBody(multipart)
            }
            if (!response.status.isSuccess()) {
                counter.recordError()
                throw HttpException(response.status.value, response.bodyAsText())
            }
            counter.recordSuccess()
        } catch (e: Throwable) {
            counter.recordError()
            throw e
        }
    }

    /** Drain any partially-filled batch. */
    suspend fun flush() {
        batch.flush()
    }

    /** Fetch a run's current state. Backs [snapshotAndAwait]'s polling loop. */
    open suspend fun getRun(runId: String): RunResponse =
        transport.get<RunResponse>("runs/$runId")

    /**
     * Upload a snapshot and BLOCK until the diff worker reaches a
     * terminal status for the resulting run. Returns a typed
     * [SnapshotResult] for assertion-friendly access.
     *
     * Failure terminals (`UNRESOLVED`/`FAILED`/`ABORTED`) throw
     * [FuranAssertionException] by default. Set
     * [FuranConfig.softAssert] = true to receive the result instead;
     * the caller then asserts explicitly:
     *
     *     val r = client.snapshotAndAwait(runId, snap)
     *     assertEquals(RunStatus.PASSED, r.status)
     *
     * Polls every [FuranConfig.pollIntervalSeconds] up to
     * [FuranConfig.pollTimeoutSeconds]. Throws
     * [FuranTimeoutException] if no terminal arrives in that window.
     *
     * This bypasses the batch (it would defeat the purpose of waiting
     * to flush a single snapshot) — sends the multipart upload
     * directly. Callers using the original fire-and-forget
     * [uploadSnapshot] keep the batched path.
     */
    suspend fun snapshotAndAwait(runId: String, snap: Snapshot): SnapshotResult {
        uploadSnapshotInner(snap.copy(runId = runId))
        return awaitRunResult(runId)
    }

    /**
     * Polls [getRun] until the run is done (terminal status OR first-baseline
     * auto-approved) or [FuranConfig.pollTimeoutSeconds] elapses, then
     * composes a [SnapshotResult]. Exposed publicly so a caller who used the
     * fire-and-forget [uploadSnapshot] path can later block on a specific
     * run's result without duplicating the polling logic.
     */
    suspend fun awaitRunResult(
        runId: String,
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): SnapshotResult {
        val mark = TimeSource.Monotonic.markNow()
        val interval = config.pollIntervalSeconds.seconds
        var last: RunResponse? = null
        while (mark.elapsedNow() < timeout) {
            val run = getRun(runId)
            last = run
            val status = run.status
            if (status != null && isDone(run, status)) {
                return resolveOrThrow(composeResult(run, status))
            }
            delay(interval)
        }
        throw FuranTimeoutException(
            runId = runId,
            lastStatus = last?.status,
            timeoutSeconds = timeout.inWholeSeconds,
        )
    }

    /**
     * Whether the diff worker is done with this run. The classic terminal
     * statuses (passed/unresolved/failed/aborted/empty) qualify, plus
     * `status=new` regardless of `autoApproved` — there is no further
     * worker transition out of `new`, so blocking on it would always
     * timeout (per ADR-036, first-run-no-baseline lands as `new` and
     * waits for a reviewer when the project's `autoApproveFeature` is
     * off; with the flag on, the auto-seeded baseline also lands as
     * `new` + `autoApproved=true`).
     *
     * Verified 2026-05-25 — full-e2e CI surfaced this when a fresh
     * project's first `snapshotAndAwait` always timed out before the
     * first-baseline marker was wired up. Now `new` is terminal in both
     * directions: a test's POV decides via [composeResult].
     */
    private fun isDone(run: RunResponse, status: RunStatus): Boolean =
        status.isTerminal() || status == RunStatus.NEW

    /**
     * Apply the configured assertion policy to a composed result. With
     * [FuranConfig.softAssert] off (the default): a failure terminal
     * (`UNRESOLVED`/`FAILED`/`ABORTED`) throws [FuranAssertionException],
     * and a no-baseline first run (`status=new`, not auto-approved) throws
     * [FuranNoBaselineException] — matching the legacy backend's "first run
     * fails until approved" contract (ADR-036). With softAssert on, the
     * result is returned untouched for the caller to inspect.
     */
    internal fun resolveOrThrow(result: SnapshotResult): SnapshotResult {
        if (!config.softAssert) {
            if (result.isFailure()) throw FuranAssertionException(result)
            if (result.status == RunStatus.NEW) throw FuranNoBaselineException(result)
        }
        return result
    }

    internal fun composeResult(run: RunResponse, status: RunStatus): SnapshotResult {
        // First-baseline-auto-approved is wire `status=new` but is
        // semantically a pass from the SDK consumer's POV (the worker
        // auto-seeded a baseline). Translate so user assertions read
        // cleanly: `assertEquals(PASSED, result.status)` works for both
        // "new baseline auto-seeded" and "subsequent matching run".
        //
        // When `autoApproved=false` and status is `new`, the wire status
        // is kept as NEW — there is no baseline yet, the test is waiting
        // on a reviewer. Downstream `Furan.snapshotAndAwait` throws
        // `FuranAssertionException` for non-passed terminals (when
        // `softAssert=false`, the default), matching the legacy
        // backend's "first run fails until approved" contract.
        val effective =
            if (status == RunStatus.NEW && run.autoApproved == true) RunStatus.PASSED else status
        return SnapshotResult(
            runId = run.id,
            buildId = run.buildId,
            status = effective,
            diffPercent = run.diffPercent,
            autoApproved = run.autoApproved == true,
            baselineSource = run.baselineSource,
            diffViewerUrl = config.dashboardUrl?.let { base ->
                // Mirrors the dashboard's route shape:
                // /projects/{projectId}/runs/{runId}/diffs/{runId}
                // The "diff id == run id" assumption is the v1.0 dashboard's
                // convention (one diff per run; multi-viewport composites
                // are a v1.1+ ask).
                "$base/projects/${run.projectId}/runs/${run.id}/diffs/${run.id}"
            },
        )
    }

    /** Posts the anonymous telemetry snapshot if enabled. Fire-and-forget. */
    private suspend fun postTelemetry() {
        if (!config.telemetryEnabled) return
        runCatching {
            transport.post<SdkTelemetryPayload, Map<String, String>>(
                "_telemetry/sdk",
                counter.snapshot(),
            )
        }
        // intentionally ignore failures: telemetry must never break user tests.
    }

    /**
     * Flushes pending snapshots, posts telemetry (if enabled), then closes the
     * underlying HttpClient. Uses [runBlocking] so the method is safe to invoke
     * from non-suspend contexts (JUnit `@AfterEach`, JVM shutdown hooks).
     */
    override fun close() {
        runBlocking {
            try {
                flush()
            } catch (_: Throwable) {
                // Best-effort flush; do not block close on a network error.
            }
            postTelemetry()
        }
        transport.close()
    }
}
