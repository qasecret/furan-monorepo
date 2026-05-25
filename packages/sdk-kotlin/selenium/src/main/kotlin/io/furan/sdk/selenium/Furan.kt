package io.furan.sdk.selenium

import io.furan.sdk.ELEMENT_BBOX_SCRIPT
import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CreateBuildRequest
import io.furan.sdk.dto.CreateRunRequest
import io.furan.sdk.dto.Snapshot
import io.furan.sdk.dto.SnapshotResult
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.openqa.selenium.Dimension
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.slf4j.LoggerFactory
import java.io.Closeable

/**
 * Public API for Furan's Selenium-Java adapter.
 *
 * ```
 * val driver = ChromeDriver()
 * val furan = Furan(driver, FuranConfig.fromEnv())
 * furan.snapshot("checkout-page")
 * furan.snapshot("checkout-modal", mask = listOf("[data-test=timer]"))
 * furan.close()
 * ```
 *
 * Lazy-initializes a Build + Run on the first `snapshot()` call. Subsequent
 * snapshots reuse the same run id. `close()` flushes any buffered snapshots
 * and posts anonymous telemetry.
 */
class Furan(
    private val driver: WebDriver,
    val config: FuranConfig,
) : Closeable {
    private val client = FuranClient(config, adapter = "selenium")
    private val createRunMutex = Mutex()

    @Volatile private var runId: String? = null
    @Volatile private var buildId: String? = config.buildId

    /**
     * Capture a screenshot + DOM at each viewport and upload.
     *
     * @param name Logical snapshot name (e.g., "checkout-page").
     * @param mask Optional CSS selectors to mask in the diff (server honors these).
     * @param viewports Override the per-call viewport list. Defaults to
     *     [FuranConfig.viewports].
     */
    fun snapshot(
        name: String,
        mask: List<String> = emptyList(),
        viewports: List<Viewport>? = null,
    ) = runBlocking {
        val targets = viewports ?: config.viewports
        val resolvedRunId = ensureRun(targets.firstOrNull())

        for (vp in targets) {
            driver.manage().window().size = Dimension(vp.width, vp.height)
            val pngBytes = captureScreenshot(driver)
            val domHtml = runCatching { captureDom(driver) }.getOrNull()
            val elementMapJson = captureElementBboxes(driver)
            client.uploadSnapshot(
                runId = resolvedRunId,
                snap = Snapshot(
                    name = name,
                    viewport = vp,
                    pngBytes = pngBytes,
                    domHtml = domHtml,
                    elementMapJson = elementMapJson,
                    mask = mask,
                    browser = "selenium",
                ),
            )
        }
    }

    /**
     * Capture + upload a single snapshot, then BLOCK until the diff
     * worker produces a terminal status. Returns a typed
     * [SnapshotResult] for assertion-friendly access.
     *
     * Unlike [snapshot], this path bypasses the SDK's snapshot batch
     * (a batch flush would defeat the point of awaiting a single
     * result) and only captures the FIRST viewport — diffing across
     * multiple viewports in one synchronous call is an anti-pattern
     * (the caller can't act on per-viewport failures distinctly).
     * Callers wanting multi-viewport should loop and call this once
     * per viewport.
     *
     * Throws [io.furan.sdk.FuranAssertionException] on UNRESOLVED /
     * FAILED / ABORTED unless `config.softAssert == true`. Throws
     * [io.furan.sdk.FuranTimeoutException] if no terminal status
     * arrives within `config.pollTimeoutSeconds`.
     *
     * ```
     * val result = furan.snapshotAndAwait("checkout-page")
     * assertEquals(RunStatus.PASSED, result.status)
     * println("Review: ${result.diffViewerUrl}")
     * ```
     */
    fun snapshotAndAwait(
        name: String,
        mask: List<String> = emptyList(),
        viewport: Viewport? = null,
    ): SnapshotResult = runBlocking {
        val vp = viewport ?: config.viewports.first()
        val resolvedRunId = ensureRun(vp)

        driver.manage().window().size = Dimension(vp.width, vp.height)
        val pngBytes = captureScreenshot(driver)
        val domHtml = runCatching { captureDom(driver) }.getOrNull()
        val elementMapJson = captureElementBboxes(driver)

        client.snapshotAndAwait(
            runId = resolvedRunId,
            snap = Snapshot(
                name = name,
                viewport = vp,
                pngBytes = pngBytes,
                domHtml = domHtml,
                elementMapJson = elementMapJson,
                mask = mask,
                browser = "selenium",
            ),
        )
    }

    /**
     * Double-checked-locking via a coroutine Mutex (avoids returning from inside
     * a `synchronized { return runBlocking { ... } }` block, which doesn't
     * compile cleanly when the outer fn is suspend).
     */
    private suspend fun ensureRun(firstViewport: Viewport?): String {
        runId?.let { return it }
        createRunMutex.withLock {
            runId?.let { return it }

            val resolvedBuildId = buildId ?: run {
                val build = client.createBuild(
                    CreateBuildRequest(
                        ciBuildId = config.buildId,
                        branchName = config.branchName,
                        name = config.name,
                        properties = config.properties.takeIf { it.isNotEmpty() },
                    ),
                )
                buildId = build.id
                build.id
            }

            val viewportStr = firstViewport?.let { "${it.width}x${it.height}" }
            val run = client.createRun(
                CreateRunRequest(
                    projectId = config.projectId,
                    buildId = resolvedBuildId,
                    branchName = config.branchName,
                    name = "snapshot-run",
                    browser = "selenium",
                    viewport = viewportStr,
                ),
            )
            runId = run.id
        }
        return runId!!
    }

    override fun close() {
        client.close()
    }

    companion object {
        private val log = LoggerFactory.getLogger(Furan::class.java)
        private const val MAX_ELEMENT_MAP_BYTES = 1_000_000

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
