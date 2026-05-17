package io.furan.sdk

import io.furan.sdk.dto.BuildResponse
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.CreateRunRequest
import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.Snapshot
import io.furan.sdk.telemetry.AnonymousCounter
import io.furan.sdk.telemetry.SdkTelemetryPayload
import io.furan.sdk.transport.Batch
import io.furan.sdk.transport.HttpTransport
import kotlinx.coroutines.runBlocking
import java.io.Closeable

/**
 * Top-level SDK orchestrator. Composes [HttpTransport] + [Batch] + telemetry.
 * Public adapters (sdk-selenium, sdk-playwright) instantiate one of these.
 *
 * Task 2 wires construction, batching scaffolding, and lifecycle. The actual
 * multipart screenshot upload is stubbed in [uploadSnapshotInner] and is wired
 * up in Task 4 once `POST /api/v1/runs/:runId/screenshots` exists.
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
                "api/v1/projects/${config.projectId}/builds",
                req,
            )
            .also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /** Create a new run. Endpoint `POST /api/v1/runs` is added in Task 4. */
    suspend fun createRun(req: CreateRunRequest): RunResponse = try {
        transport
            .post<CreateRunRequest, RunResponse>("api/v1/runs", req)
            .also { counter.recordSuccess() }
    } catch (e: Throwable) {
        counter.recordError()
        throw e
    }

    /**
     * Offer a snapshot to the batch. Flush happens automatically when the
     * batch reaches `config.batchSize`, or on [flush]/[close].
     */
    suspend fun uploadSnapshot(@Suppress("UNUSED_PARAMETER") runId: String, snap: Snapshot) {
        // runId is unused until Task 4 wires the actual multipart upload below.
        batch.offer(snap)
    }

    private suspend fun uploadSnapshotInner(@Suppress("UNUSED_PARAMETER") snap: Snapshot) {
        // Task 4: POST /api/v1/runs/:runId/screenshots (multipart: image + dom).
        // For now: count as a success so batch flushing is observable in tests
        // without requiring a live API. Per-snapshot runId carry-through will be
        // added when the upload route exists.
        try {
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

    /** Posts the anonymous telemetry snapshot if enabled. Fire-and-forget. */
    private suspend fun postTelemetry() {
        if (!config.telemetryEnabled) return
        runCatching {
            transport.post<SdkTelemetryPayload, Map<String, String>>(
                "api/v1/_telemetry/sdk",
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
