package io.furan.sdk.capture

import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Unit tests for the Tier 1.3 pre-capture hooks
 * (`beforeCaptureScreenshot` + `waitBeforeCaptureMs`), now driven directly
 * through [CaptureEngine.capture] against a [FakeSpecDriver].
 *
 * Lifted from the selenium adapter's CaptureHooksTest. The original could
 * not reach Furan.snapshotSuspend without a live HTTP path, so it mirrored
 * the hook sequence in a standalone `runCaptureHooks` helper. With the
 * orchestration in CaptureEngine that mirror is gone — we exercise the real
 * production sequence (executeScript → lazy-load → delay → capture). Each
 * checkpoint uses `sendDom = false` and no region, so the only JS the engine
 * runs on the web path is the hook (if any) plus the element-map script;
 * we assert specifically on the hook's presence rather than total script
 * count.
 *
 * All tests use `runBlocking` to keep the class uniform; the timing cases
 * (`waitBeforeCaptureMs`) need real time — `runTest`'s virtual clock would
 * fast-forward the delay and make those assertions vacuous.
 */
class CaptureHooksTest {
    private val vp = Viewport(800, 600)

    /** A web-capable driver whose every script eval returns null. */
    private fun webDriver() = FakeSpecDriver(
        driverInfo = DriverInfo(
            browserName = "selenium",
            features = setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT, Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT),
        ),
        onTakeScreenshot = { byteArrayOf(1) },
        onExecuteScript = { _, _ -> null },
    )

    /** A native (no-JS) driver — the engine must never run the hook on it. */
    private fun nativeDriver() = FakeSpecDriver(
        driverInfo = DriverInfo(isNative = true, browserName = "appium"),
        onTakeScreenshot = { byteArrayOf(1) },
    )

    @Test
    fun `beforeCaptureScreenshot executes script on JS driver`() = runBlocking {
        val driver = webDriver()
        val hook = "document.querySelector('.modal').style.display='none';"
        CaptureEngine(driver).capture("h", CheckpointOptions(beforeCaptureScreenshot = hook, sendDom = false), vp)
        assertTrue(driver.executedScripts.any { it == hook }, "expected the hook script to run")
    }

    @Test
    fun `null hook is a no-op`() = runBlocking {
        val driver = webDriver()
        CaptureEngine(driver).capture("h", CheckpointOptions(sendDom = false), vp)
        // No hook script was supplied, so none of the executed scripts is a hook.
        // (The engine still runs the element-map script; that is not a hook.)
        assertFalse(driver.executedScripts.any { it.startsWith("document.querySelector") })
    }

    @Test
    fun `non-JS driver silently skips the hook`() = runBlocking {
        // A native driver has no JAVASCRIPT feature; the engine takes the
        // single-screenshot path and never evaluates the hook (or any JS).
        val driver = nativeDriver()
        CaptureEngine(driver).capture("h", CheckpointOptions(beforeCaptureScreenshot = "alert('hi');"), vp)
        assertTrue(driver.executedScripts.isEmpty(), "no JS should run on a native driver")
    }

    @Test
    fun `waitBeforeCaptureMs waits at least the requested duration`() = runBlocking {
        val driver = webDriver()
        val start = System.nanoTime()
        CaptureEngine(driver).capture("h", CheckpointOptions(waitBeforeCaptureMs = 100, sendDom = false), vp)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue(elapsedMs >= 95, "expected ≥95ms, got ${elapsedMs}ms")
    }

    @Test
    fun `wait of zero does not block`() = runBlocking {
        val driver = webDriver()
        val start = System.nanoTime()
        CaptureEngine(driver).capture("h", CheckpointOptions(waitBeforeCaptureMs = 0, sendDom = false), vp)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue(elapsedMs < 50, "expected <50ms, got ${elapsedMs}ms")
    }

    @Test
    fun `hook runs before the screenshot`() = runBlocking {
        // The hook must run before pixels are captured (deterministic DOM
        // mutation → screenshot). The engine records the hook script before
        // it calls takeScreenshot in the stable-capture path.
        val driver = webDriver()
        CaptureEngine(driver).capture(
            "h",
            CheckpointOptions(beforeCaptureScreenshot = "window.x = 1;", waitBeforeCaptureMs = 30, sendDom = false),
            vp,
        )
        // The hook must be the FIRST script executed (viewport resize is a
        // setViewportSize call, not a script; lazy-load and element-map run
        // after).
        assertEquals("window.x = 1;", driver.executedScripts.first(),
            "beforeCaptureScreenshot hook must be the first script executed")
        assertTrue(driver.screenshotCount >= 1, "a screenshot should have been taken after the hook")
    }

    @Test
    fun `JS error propagates instead of corrupting baseline`() {
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(
                browserName = "selenium",
                features = setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT, Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT),
            ),
            onTakeScreenshot = { byteArrayOf(1) },
            onExecuteScript = { script, _ -> throw RuntimeException("JS error: $script") },
        )
        val ex = runCatching {
            runBlocking {
                CaptureEngine(driver).capture(
                    "h",
                    CheckpointOptions(beforeCaptureScreenshot = "throw new Error('boom')", sendDom = false),
                    vp,
                )
            }
        }.exceptionOrNull()
        assertTrue(ex is RuntimeException, "expected JS error to surface; got $ex")
    }
}
