package io.furan.sdk.selenium

import io.furan.sdk.FailOnDiff
import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranDiffException
import io.furan.sdk.Viewport
import io.furan.sdk.capture.CaptureEngine
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.openqa.selenium.WebDriver
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Public API for Furan's Selenium-Java adapter (SDK 2.0.0, ADR-038).
 *
 * Explicit lifecycle — callers must open before snapshotting:
 *
 * ```kotlin
 * val furan = Furan(FuranConfig.fromEnv(), driver)
 * furan.open("GoogleSearchFlow")
 * furan.snapshot("HomePage")
 * furan.snapshot("ResultsPage")
 * val result = furan.close()   // returns RunResult?
 * ```
 *
 * On test failure:
 * ```kotlin
 * try {
 *     furan.open("MyTest")
 *     furan.snapshot("step1")
 *     // ... test logic
 *     furan.close()
 * } catch (e: Throwable) {
 *     furan.abort()
 *     throw e
 * }
 * ```
 *
 * Or use the convenience [Furan.use] companion:
 * ```kotlin
 * Furan.use(config, driver, "MyTest") { furan ->
 *     furan.snapshot("step1")
 * }
 * ```
 *
 * [FailOnDiff.AfterEach] (set on [FuranConfig.failOnDiff]) causes [close]
 * to throw [FuranDiffException] when the run ends with any non-passing status.
 */
class Furan(
    val config: FuranConfig,
    private val driver: WebDriver,
) {
    private val client = FuranClient(config, adapter = "selenium")
    private val specDriver = SeleniumSpecDriver(driver)
    private val captureEngine = CaptureEngine(specDriver)
    private val ensureBuildMutex = Mutex()

    @Volatile private var buildId: String? = config.buildId
    @Volatile private var runId: String? = null

    /**
     * Opens a new test run with the given [testName]. Ensures a build exists
     * (lazy, mutex-guarded) then calls `POST /runs`.
     *
     * @throws IllegalStateException if a run is already open on this instance.
     */
    fun open(testName: String): Unit = runBlocking {
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

    /**
     * Capture a screenshot + optional DOM from the current driver state and
     * upload to the open run as a checkpoint. Uses the first configured
     * viewport by default.
     *
     * @throws IllegalStateException if no run is open (call [open] first).
     */
    fun snapshot(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
    ): CheckpointSubmission {
        val rid = runId ?: error("call furan.open(testName) before snapshot()")
        return runBlocking { snapshotSuspend(rid, name, options, viewport) }
    }

    /**
     * Capture + upload a single snapshot, then block until the diff worker
     * reaches a terminal status. Returns a [CheckpointResult].
     *
     * Unlike [snapshot], this bypasses the snapshot batch and only processes
     * the first viewport.
     *
     * @throws IllegalStateException if no run is open.
     * @throws io.furan.sdk.FuranTimeoutException if no terminal status arrives
     *   within [timeout].
     */
    fun snapshotAndAwait(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult {
        val rid = runId ?: error("call furan.open(testName) before snapshot()")
        return runBlocking {
            val submission = snapshotSuspend(rid, name, options, viewport)
            client.awaitCheckpoint(
                checkpointId = submission.checkpointId,
                timeout = timeout,
                runId = rid,
            )
        }
    }

    /** Internal suspend implementation of screenshot capture + upload. */
    private suspend fun snapshotSuspend(
        rid: String,
        name: String,
        options: CheckpointOptions,
        viewport: Viewport?,
    ): CheckpointSubmission {
        val vp = viewport ?: config.viewports.first()
        val capture = captureEngine.capture(name, options, vp)
        return client.createScreenshot(
            runId = rid,
            name = name,
            viewport = capture.viewport,
            browser = capture.browser ?: "selenium",
            os = capture.os,
            device = capture.device,
            matchLevel = options.matchLevel,
            regions = capture.regions,
            pngBytes = capture.pngBytes,
            domHtml = capture.domHtml,
            elementMapJson = capture.elementMapJson,
            ignoreDisplacements = options.ignoreDisplacements,
            accessibilityLevel = options.accessibilitySettings?.level?.wire,
            accessibilityVersion = options.accessibilitySettings?.guidelinesVersion?.wire,
        )
    }

    /**
     * Complete the open run: calls `POST /runs/:id/complete` and resets
     * the run state. Returns the [RunResult] for assertion.
     *
     * If [FuranConfig.failOnDiff] is [FailOnDiff.AfterEach] and the run
     * ended with a non-passing status, throws [FuranDiffException].
     *
     * @return the [RunResult], or null if no run was open.
     */
    fun close(): RunResult? = runBlocking {
        val rid = runId ?: return@runBlocking null
        val result = client.completeRun(rid)
        runId = null
        if (config.failOnDiff == FailOnDiff.AfterEach && !result.status.isPassing()) {
            throw FuranDiffException(result)
        }
        result
    }

    /**
     * Abort the open run (marks it `aborted` on the server) and reset state.
     * Idempotent — safe to call even if no run is open.
     */
    fun abort(): Unit = runBlocking {
        val rid = runId ?: return@runBlocking
        client.abortRun(rid)
        runId = null
    }

    /**
     * Build is shared across all open() calls on one Furan instance.
     * Double-checked-locking via a coroutine Mutex.
     */
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
         * Convenience factory: opens a run, runs [block], closes on success,
         * aborts on exception. Returns the block's result.
         *
         * ```kotlin
         * val result = Furan.use(config, driver, "MyTest") { furan ->
         *     furan.snapshot("step1")
         *     furan.close()
         * }
         * ```
         */
        fun <R> use(
            config: FuranConfig,
            driver: WebDriver,
            testName: String,
            block: (Furan) -> R,
        ): R {
            val furan = Furan(config, driver)
            return try {
                furan.open(testName)
                val result = block(furan)
                furan.close()
                result
            } catch (e: Throwable) {
                runCatching { furan.abort() }
                throw e
            }
        }

        /**
         * Tier 1.5 (Eyes-parity `runner.getAllTestResults`): wrap a
         * collection of completed [RunResult]s in a [SuiteResult] for
         * uniform CI reporting (derived counts, pass/fail summary, etc).
         *
         * For tests using [FuranExtension], prefer
         * `FuranExtension.getSuiteResult(extensionContext)` which auto-
         * collects every [close] result from the suite. This factory is
         * for the manual case (tests not on the extension path) and for
         * Java callers that want a single static entry point.
         */
        @JvmStatic
        fun aggregateResults(runs: List<RunResult>): SuiteResult = SuiteResult(runs)
    }
}
