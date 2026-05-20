package io.furan.sdk

import io.furan.sdk.dto.BuildResponse
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.CreateRunRequest
import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.Snapshot
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
import kotlinx.coroutines.runBlocking
import java.io.Closeable
import java.util.UUID

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
