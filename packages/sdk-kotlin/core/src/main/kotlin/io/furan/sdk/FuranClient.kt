package io.furan.sdk

import io.furan.sdk.dto.BuildResponse
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.CreateRunRequest
import io.furan.sdk.dto.RunResponse
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
import java.io.Closeable
import java.util.UUID
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
class FuranClient(
    val config: FuranConfig,
    val adapter: String = "unknown",
) : Closeable {
    private val transport = HttpTransport(config)
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
    suspend fun getRun(runId: String): RunResponse =
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
    suspend fun awaitRunResult(runId: String): SnapshotResult {
        val mark = TimeSource.Monotonic.markNow()
        val timeout = config.pollTimeoutSeconds.seconds
        val interval = config.pollIntervalSeconds.seconds
        var last: RunResponse? = null
        while (mark.elapsedNow() < timeout) {
            val run = getRun(runId)
            last = run
            val status = run.status
            if (status != null && isDone(run, status)) {
                val result = composeResult(run, status)
                if (result.isFailure() && !config.softAssert) {
                    throw FuranAssertionException(result)
                }
                return result
            }
            delay(interval)
        }
        throw FuranTimeoutException(
            runId = runId,
            lastStatus = last?.status,
            timeoutSeconds = config.pollTimeoutSeconds,
        )
    }

    /**
     * Whether the diff worker is done with this run. The classic terminal
     * statuses (passed/unresolved/failed/aborted/empty) qualify, plus the
     * first-baseline edge case: `status=new` with `autoApproved=true` is
     * the dashboard's marker for "this run created the first baseline for
     * this variation, no prior baseline existed to compare against, the
     * worker is done." That's a SUCCESSFUL terminal from a test's POV
     * even though the wire status stays `new` forever (the dashboard uses
     * `status=new` to render the "first baseline" pill).
     *
     * Verified 2026-05-25 — full-e2e CI surfaced this when a fresh
     * project's first `snapshotAndAwait` always timed out: every CI run
     * is a first-baseline by definition.
     */
    private fun isDone(run: RunResponse, status: RunStatus): Boolean =
        status.isTerminal() || (status == RunStatus.NEW && run.autoApproved == true)

    internal fun composeResult(run: RunResponse, status: RunStatus): SnapshotResult {
        // First-baseline-auto-approved is wire `status=new` but is
        // semantically a pass from the SDK consumer's POV. Translate so
        // user assertions read cleanly: `assertEquals(PASSED, result.status)`
        // works for both "new baseline" and "subsequent matching run".
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
