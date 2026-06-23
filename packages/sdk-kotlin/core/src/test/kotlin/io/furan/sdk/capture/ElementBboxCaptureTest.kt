package io.furan.sdk.capture

import io.furan.sdk.ELEMENT_BBOX_SCRIPT
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Drives CaptureEngine.captureElementBboxes() directly with a FakeSpecDriver
 * — pure unit tests, no real browser. The headless-Chrome end-to-end coverage
 * lives in SnapshotIntegrationTest (opt-in via FURAN_SDK_INTEGRATION=1).
 *
 * Lifted from the selenium adapter's ElementBboxCaptureTest when the
 * element-map capture moved into the driver-agnostic CaptureEngine. The
 * former "driver is not a JavascriptExecutor → null" case (a Selenium-only
 * distinction) is re-expressed as "executeScript returns null → null": in the
 * SpecDriver world there is no JS-executor split — a non-JS driver simply
 * never has the engine call executeScript, so a null script result is the
 * equivalent observable outcome (empty element map).
 */
class ElementBboxCaptureTest {

    /** A FakeSpecDriver whose ELEMENT_BBOX_SCRIPT eval returns [scriptResult]. */
    private fun bboxDriver(scriptResult: Any?, throwOnScript: Boolean = false) =
        FakeSpecDriver(
            onExecuteScript = { script, _ ->
                if (throwOnScript) throw RuntimeException("driver disconnected")
                if (script == ELEMENT_BBOX_SCRIPT) scriptResult else null
            },
        )

    @Test
    fun `returns the raw JSON string when driver returns one`() {
        val payload = """{"v":1,"elements":{},"capturedAt":1}"""
        val driver = bboxDriver(scriptResult = payload)
        val result = CaptureEngine.captureElementBboxes(driver)
        assertEquals(payload, result)
    }

    @Test
    fun `returns null when executeScript returns null`() {
        val driver = bboxDriver(scriptResult = null)
        val result = CaptureEngine.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when executeScript returns a non-String`() {
        val driver = bboxDriver(scriptResult = 42)
        val result = CaptureEngine.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when executeScript throws`() {
        val driver = bboxDriver(scriptResult = null, throwOnScript = true)
        val result = CaptureEngine.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when payload exceeds 1 MB ceiling`() {
        val huge = "x".repeat(1_000_001)
        val driver = bboxDriver(scriptResult = huge)
        val result = CaptureEngine.captureElementBboxes(driver)
        assertNull(result)
    }
}
