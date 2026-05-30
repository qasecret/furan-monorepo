package io.furan.sdk.selenium

import io.furan.sdk.ELEMENT_BBOX_SCRIPT
import io.furan.sdk.FailOnDiff
import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranDiffException
import io.furan.sdk.Regions
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.Region
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.openqa.selenium.Dimension
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.slf4j.LoggerFactory
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
        driver.manage().window().size = Dimension(vp.width, vp.height)
        // Tier 1.3: pre-capture hooks. JS first (deterministic DOM
        // mutation) → wait (let the change settle) → screenshot. A
        // thrown JS error propagates so the test sees the failure rather
        // than a degraded baseline. A non-JS driver silently skips the
        // hook (would only happen with a non-browser stub).
        options.beforeCaptureScreenshot?.let { js ->
            (driver as? JavascriptExecutor)?.executeScript(js)
        }
        // Tier 2.1: lazy-load scroll loop. Runs AFTER the JS hook (so
        // user-injected DOM mutations land first) and BEFORE the final
        // wait (so any animation that the last scroll triggered gets
        // the settle budget). Restores scroll position to top before
        // returning so the screenshot frames the page header.
        options.lazyLoad?.let { lazyLoad ->
            runLazyLoadScroll(driver, lazyLoad)
        }
        if (options.waitBeforeCaptureMs > 0) {
            kotlinx.coroutines.delay(options.waitBeforeCaptureMs)
        }
        // ADR-038 / Tier 1.2: region with selector → element-direct capture
        // (bypasses viewport + crop entirely; faster and exact). region with
        // only numeric coords → viewport capture + cropPng. region null →
        // full viewport upload.
        val captureRegion = options.region
        val captureSelector = captureRegion?.selector
        if (options.fully && options.matchTimeoutMs > 0) {
            warnMatchTimeoutIgnoredInFullyMode()
        }
        val pngBytes = when {
            // Element-direct capture path is element-scoped, not full-page;
            // a selector-anchored region with fully=true still means
            // "stitch the full page" — the user wants the whole document.
            // We honor `fully` over the element-direct shortcut, then crop
            // the stitched image to the resolved bbox.
            options.fully && captureRegion != null -> {
                val stitched = withHideFixed(driver, options.hideFixedElements) {
                    captureFullyPage(driver, viewportWidth = vp.width, viewportHeight = vp.height)
                }
                val resolved = resolveRegion(driver, captureRegion)
                cropPng(stitched, resolved)
            }
            options.fully -> withHideFixed(driver, options.hideFixedElements) {
                captureFullyPage(driver, viewportWidth = vp.width, viewportHeight = vp.height)
            }
            captureRegion != null && captureSelector != null ->
                // Element-direct capture skips the stability poll —
                // Selenium's element screenshot is a single operation
                // and the per-sample cost isn't justified. Use
                // `waitBeforeCaptureMs` to stabilize before this path.
                captureElementScreenshot(driver, captureSelector)
            captureRegion != null -> {
                val resolved = resolveRegion(driver, captureRegion)
                cropPng(captureStableScreenshot(driver, options.matchTimeoutMs), resolved)
            }
            else -> captureStableScreenshot(driver, options.matchTimeoutMs)
        }
        // Tier 1.2: resolve any selector-anchored mask regions to numeric
        // coords against the live DOM before sending. Selector-less regions
        // pass through unchanged.
        //
        // Tier 2.4: when ignoreCaret = true, augmentIgnoreRegions appends
        // a selector-anchored ignore for the focused text input so a
        // blinking caret doesn't flag as a diff.
        val ignore = augmentIgnoreRegions(options.ignoreRegions, options.ignoreCaret)
            .map { resolveRegion(driver, it) }
        val layout = options.layoutRegions.map { resolveRegion(driver, it) }
        val content = options.contentRegions.map { resolveRegion(driver, it) }
        // Tier 2.2: `sendDom = false` skips DOM auto-capture entirely.
        // See [resolveDomPayload] for precedence rules.
        val domHtml = resolveDomPayload(
            override = options.domHtml,
            sendDom = options.sendDom,
            capture = { captureDom(driver) },
        )
        val elementMapJson = options.elementMapJson ?: captureElementBboxes(driver)
        return client.createScreenshot(
            runId = rid,
            name = name,
            viewport = "${vp.width}x${vp.height}",
            browser = "selenium",
            os = null,
            device = null,
            matchLevel = options.matchLevel,
            regions = Regions(
                ignore = ignore,
                layout = layout,
                floating = options.floatingRegions,
                content = content,
                accessibility = options.accessibilityRegions,
            ),
            pngBytes = pngBytes,
            domHtml = domHtml,
            elementMapJson = elementMapJson,
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
        runId = null
        val result = client.completeRun(rid)
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
        runId = null
        client.abortRun(rid)
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

    /**
     * Inject the hide-fixed-elements stylesheet (if any), run [block],
     * then restore. Wraps the stitch loop in try/finally so a thrown
     * exception during capture still removes the injected style.
     */
    private suspend fun <R> withHideFixed(
        driver: WebDriver,
        selectors: List<String>,
        block: suspend () -> R,
    ): R {
        if (selectors.isEmpty()) return block()
        injectFixedElementHider(driver, selectors)
        try {
            return block()
        } finally {
            runCatching { removeFixedElementHider(driver) }
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(Furan::class.java)
        private const val MAX_ELEMENT_MAP_BYTES = 1_000_000

        /**
         * Tier 2.4: selector-anchored ignore region auto-appended when
         * `CheckpointOptions.ignoreCaret = true`. Covers the three
         * places a blinking caret typically lives.
         */
        internal val CARET_FOCUS_REGION: Region =
            Region.bySelector("input:focus, textarea:focus, [contenteditable]:focus")

        /**
         * Tier 2.4: append the focused-input ignore region when
         * [ignoreCaret] is set. Pure function — exposed for unit tests
         * so the augmentation logic can be exercised without a live
         * driver.
         */
        internal fun augmentIgnoreRegions(
            ignoreRegions: List<Region>,
            ignoreCaret: Boolean,
        ): List<Region> = if (ignoreCaret) ignoreRegions + CARET_FOCUS_REGION else ignoreRegions

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

        /**
         * Best-effort: drops the map silently on any failure (non-JS driver,
         * thrown JS, oversized payload). Never blocks the screenshot upload.
         */
        internal fun captureElementBboxes(driver: WebDriver): String? = try {
            val js = driver as? JavascriptExecutor
            if (js == null) {
                null
            } else {
                val raw = js.executeScript(ELEMENT_BBOX_SCRIPT) as? String
                when {
                    raw == null -> null
                    raw.length > MAX_ELEMENT_MAP_BYTES -> {
                        log.warn(
                            "Element map {} bytes exceeds {}; dropping",
                            raw.length,
                            MAX_ELEMENT_MAP_BYTES,
                        )
                        null
                    }
                    else -> raw
                }
            }
        } catch (e: Exception) {
            log.warn("Element bbox capture failed; continuing without it", e)
            null
        }
    }
}

/** Extension on RunStatus used internally to decide whether to throw FuranDiffException. */
private fun io.furan.sdk.dto.RunStatus.isPassing(): Boolean =
    this == io.furan.sdk.dto.RunStatus.PASSED
