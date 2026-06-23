package io.furan.sdk.images

import io.furan.sdk.FailOnDiff
import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranDiffException
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.awt.image.BufferedImage
import java.io.File
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Driverless visual-checkpoint API: take a checkpoint from a raw image with
 * no WebDriver. Lives in `furan-core`, so a Playwright / Appium / mobile /
 * canvas / PDF caller depends only on core.
 *
 * Lifecycle mirrors the Selenium adapter 1:1 — open a run, check one or more
 * images, then close (or abort). Prefer the [use] companion, which opens,
 * runs your block, closes on success / aborts on exception, and releases the
 * underlying client:
 *
 * ```kotlin
 * val result = FuranImages.use(FuranConfig.fromEnv(), "checkout page") { furan ->
 *     furan.checkImageAndAwait("checkout", page.screenshot(),
 *         ImageCheckpointOptions(browser = "playwright-chromium"))
 * }
 * ```
 *
 * Failure model is identical to the Selenium adapter: with `softAssert = false`,
 * [checkImageAndAwait] throws [io.furan.sdk.FuranAssertionException] on a
 * regression, [io.furan.sdk.FuranNoBaselineException] on a first run, and
 * [io.furan.sdk.FuranTimeoutException] on timeout.
 */
class FuranImages(val config: FuranConfig) {

    private val client = FuranClient(config, adapter = "images")
    private val ensureBuildMutex = Mutex()
    private val runMutex = Mutex()

    @Volatile private var buildId: String? = config.buildId
    @Volatile private var runId: String? = null

    /** Open a new run. Ensures a build exists (lazy), then `POST /runs`. */
    fun open(testName: String): Unit = runBlocking {
        runMutex.withLock {
            check(runId == null) {
                "a run is already open; call close() or abort() before opening a new run"
            }
            val bid = ensureBuild()
            val created = client.createRun2(
                buildId = bid,
                projectId = config.projectId,
                name = testName,
                branchName = config.branchName,
                parentBranchName = config.parentBranchName,
            )
            runId = created.runId
        }
    }

    /**
     * Upload an image as a checkpoint and return immediately, without waiting
     * for the diff verdict. Accepts PNG bytes, a [File], a [BufferedImage], or
     * base64 ([checkImageBase64]). Requires an open run.
     */
    fun checkImage(name: String, png: ByteArray, options: ImageCheckpointOptions = ImageCheckpointOptions()): CheckpointSubmission {
        val rid = requireRunId()
        return submitImage(rid, name, ImageNormalizer.normalize(png), options)
    }

    fun checkImage(name: String, image: File, options: ImageCheckpointOptions = ImageCheckpointOptions()): CheckpointSubmission {
        val rid = requireRunId()
        return submitImage(rid, name, ImageNormalizer.normalize(image), options)
    }

    fun checkImage(name: String, image: BufferedImage, options: ImageCheckpointOptions = ImageCheckpointOptions()): CheckpointSubmission {
        val rid = requireRunId()
        return submitImage(rid, name, ImageNormalizer.normalize(image), options)
    }

    fun checkImageBase64(name: String, base64: String, options: ImageCheckpointOptions = ImageCheckpointOptions()): CheckpointSubmission {
        val rid = requireRunId()
        return submitImage(rid, name, ImageNormalizer.normalizeBase64(base64), options)
    }

    /**
     * Upload an image as a checkpoint and block until the diff worker reaches a
     * terminal status. With `softAssert = false`, throws on a regression / first
     * run / timeout (see class KDoc). Requires an open run.
     */
    fun checkImageAndAwait(
        name: String,
        png: ByteArray,
        options: ImageCheckpointOptions = ImageCheckpointOptions(),
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult {
        val rid = requireRunId()
        return awaitImage(rid, name, ImageNormalizer.normalize(png), options, timeout)
    }

    fun checkImageAndAwait(
        name: String,
        image: File,
        options: ImageCheckpointOptions = ImageCheckpointOptions(),
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult {
        val rid = requireRunId()
        return awaitImage(rid, name, ImageNormalizer.normalize(image), options, timeout)
    }

    fun checkImageAndAwait(
        name: String,
        image: BufferedImage,
        options: ImageCheckpointOptions = ImageCheckpointOptions(),
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult {
        val rid = requireRunId()
        return awaitImage(rid, name, ImageNormalizer.normalize(image), options, timeout)
    }

    fun checkImageBase64AndAwait(
        name: String,
        base64: String,
        options: ImageCheckpointOptions = ImageCheckpointOptions(),
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult {
        val rid = requireRunId()
        return awaitImage(rid, name, ImageNormalizer.normalizeBase64(base64), options, timeout)
    }

    /**
     * Complete the open run; returns null if no run is open. The run is cleared
     * only after the server call succeeds, so a failed complete leaves it open
     * for a retry/abort rather than orphaning it server-side.
     *
     * Throws [FuranDiffException] when [FuranConfig.failOnDiff] is
     * [FailOnDiff.AfterEach] or [FailOnDiff.AfterAll] and the run did not pass.
     * (Deferred suite-level AfterAll is not implemented on the image adapter —
     * both modes fail at close; use [aggregateResults] for a suite summary.)
     */
    fun close(): RunResult? = runBlocking {
        val rid = runId ?: return@runBlocking null
        val result = client.completeRun(rid)
        runId = null
        if (config.failOnDiff != FailOnDiff.None && !result.status.isPassing()) {
            throw FuranDiffException(result)
        }
        result
    }

    /** Abort the open run. Idempotent. Clears the run only after the server call succeeds. */
    fun abort(): Unit = runBlocking {
        val rid = runId ?: return@runBlocking
        client.abortRun(rid)
        runId = null
    }

    /** Release the underlying HTTP client (flush batch + telemetry + close transport). */
    internal fun closeClient() = client.close()

    private fun requireRunId(): String =
        runId ?: error("call furan.open(testName) before checkImage()")

    private fun submitImage(rid: String, name: String, image: NormalizedImage, options: ImageCheckpointOptions): CheckpointSubmission {
        val resolved = ImageCheckpointResolver.resolve(name, options, image)
        return runBlocking { submit(rid, resolved) }
    }

    private fun awaitImage(rid: String, name: String, image: NormalizedImage, options: ImageCheckpointOptions, timeout: Duration): CheckpointResult {
        val resolved = ImageCheckpointResolver.resolve(name, options, image)
        return runBlocking {
            val submission = submit(rid, resolved)
            client.awaitCheckpoint(checkpointId = submission.checkpointId, timeout = timeout, runId = rid)
        }
    }

    private suspend fun submit(rid: String, r: ResolvedImageCheckpoint): CheckpointSubmission =
        client.createScreenshot(
            runId = rid,
            name = r.name,
            viewport = r.viewport,
            browser = r.browser,
            os = r.os,
            device = r.device,
            matchLevel = r.matchLevel,
            regions = r.regions,
            pngBytes = r.pngBytes,
            domHtml = r.domHtml,
            elementMapJson = r.elementMapJson,
            ignoreDisplacements = r.ignoreDisplacements,
            accessibilityLevel = r.accessibilityLevel,
            accessibilityVersion = r.accessibilityVersion,
        )

    private suspend fun ensureBuild(): String {
        buildId?.let { return it }
        ensureBuildMutex.withLock {
            buildId?.let { return it }
            val build = client.createBuild(
                CreateBuildRequest(
                    ciBuildId = config.buildId,
                    branchName = config.branchName,
                    name = config.name,
                    properties = config.properties.takeIf { it.isNotEmpty() },
                ),
            )
            buildId = build.id
        }
        return buildId!!
    }

    companion object {
        /**
         * Open a run, run [block], close on success / abort on exception, and
         * release the client. The blessed path for one run per test.
         */
        fun <R> use(config: FuranConfig, testName: String, block: (FuranImages) -> R): R {
            val furan = FuranImages(config)
            return try {
                furan.open(testName)
                val result = block(furan)
                furan.close()
                result
            } catch (e: Throwable) {
                runCatching { furan.abort() }
                throw e
            } finally {
                runCatching { furan.closeClient() }
            }
        }

        /** Eyes-parity `runner.getAllTestResults()` — wrap completed runs for CI reporting. */
        @JvmStatic
        fun aggregateResults(runs: List<RunResult>): SuiteResult = SuiteResult(runs)
    }
}
