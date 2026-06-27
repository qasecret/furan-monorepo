package io.furan.sdk

import io.furan.sdk.capture.CaptureEngine
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.SuiteResult
import io.furan.sdk.spec.SpecDriver
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * The driver-agnostic capture lifecycle shared by every Furan adapter
 * (Selenium, Playwright, …). Holds the build/run state and drives a
 * [SpecDriver] through the [CaptureEngine]. Usable directly with any
 * `SpecDriver`; the typed `Furan` / `FuranPlaywright` wrappers are the
 * blessed entry points.
 *
 * @param adapter the SDK-integration label sent to the backend as telemetry
 *   (User-Agent), e.g. "selenium" / "playwright". Distinct from the baseline
 *   `browser` label, which the engine fills from `SpecDriver.getDriverInfo()`.
 */
class FuranCapture
/**
 * Internal constructor used by tests to inject a pre-built [FuranClient] stub.
 * Production code must use the public constructor, which creates the real client.
 */
internal constructor(
    val config: FuranConfig,
    driver: SpecDriver,
    private val adapter: String,
    private val client: FuranClient,
) {
    /** Primary public constructor — creates the real [FuranClient]. */
    constructor(config: FuranConfig, driver: SpecDriver, adapter: String) :
        this(config, driver, adapter, FuranClient(config, adapter = adapter))

    private val captureEngine = CaptureEngine(driver)
    private val ensureBuildMutex = Mutex()

    @Volatile private var buildId: String? = config.buildId
    @Volatile private var runId: String? = null

    /**
     * Test-only hook: pre-set the runId so [close] / [abort] can operate on a
     * synthetic "open" run without going through the network path of [open].
     */
    internal fun injectRunId(id: String) {
        runId = id
    }

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
     * @throws FuranTimeoutException if no terminal status arrives within [timeout].
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
            // Browser: explicit FURAN_BROWSER override wins, else the adapter's
            // detected browser (capture.browser), else the adapter name as a
            // last resort. os/device: explicit config wins over the (often
            // null) adapter capture. All three feed the variation's env tuple.
            browser = config.browser ?: capture.browser ?: adapter,
            os = config.os ?: capture.os,
            device = config.device ?: capture.device,
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
        val result = client.completeAndAwaitRun(rid)
        if (result.status == RunStatus.EMPTY) {
            runId = null
            println("[furan-sdk] WARN: Visual test completed without checkpoints (run $rid).")
            return@runBlocking result
        }
        // Phase 3: Eyes saveNewTests — approve a no-baseline `new` run as a
        // DISTINCT step, then re-fetch. A failed approve propagates (we do NOT
        // report passed), keeping the lifecycle deterministic.
        // runId is kept non-null until ALL server interactions complete so a
        // network throw during approve/getRun leaves the run resolvable.
        if (result.status == RunStatus.NEW && config.saveNewTests) {
            client.approveRun(rid)
            val refreshed = client.getRun(rid)
            // All server interactions done — safe to null the runId now.
            runId = null
            // #3a: a null/unknown post-approve status must NOT read as a pass.
            // Fall back to UNRESOLVED (the safe non-passing default) rather
            // than fabricating PASSED — approve does not guarantee a passing
            // verdict, and an absent status is a "couldn't determine" signal.
            val refreshedResult = RunResult(
                rid,
                refreshed.status ?: RunStatus.UNRESOLVED,
                result.checkpointCount,
                result.checkpoints,
            )
            // #3b: the saveNewTests branch must still honor FailOnDiff. A
            // post-approve non-passing status (e.g. the approve seeded a
            // baseline but the run is still unresolved) must fail the test
            // when failOnDiff == AfterEach, not silently return.
            if (config.failOnDiff == FailOnDiff.AfterEach && !refreshedResult.status.isPassing()) {
                throw FuranDiffException(refreshedResult)
            }
            return@runBlocking refreshedResult
        }
        // All server interactions done — safe to null the runId now.
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
     * Build is shared across all open() calls on one FuranCapture instance.
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
        /** Eyes-parity runner.getAllTestResults() — wrap completed RunResults for uniform CI reporting. */
        @JvmStatic
        fun aggregateResults(runs: List<RunResult>): SuiteResult = SuiteResult(runs)
    }
}
