package io.furan.sdk.capture

import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CaptureEngineTest {
    private val vp = Viewport(800, 600)

    private fun webDriver() = FakeSpecDriver(
        driverInfo = DriverInfo(
            browserName = "selenium",
            features = setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT, Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT),
        ),
        onTakeScreenshot = { byteArrayOf(1) },
        onExecuteScript = { script, _ ->
            when {
                "outerHTML" in script -> "<html></html>"
                "clientWidth" in script -> 800
                "scrollHeight" in script -> 600
                else -> null  // element-map (ELEMENT_BBOX_SCRIPT) etc. return null
            }
        },
    )

    @Test
    fun `web path fills the frozen env tuple and captures dom`() = runTest {
        val driver = webDriver()
        val result = CaptureEngine(driver).capture("home", CheckpointOptions(), vp)
        assertEquals("800x600", result.viewport)
        assertEquals("selenium", result.browser)  // from DriverInfo — invariant
        assertNull(result.os)
        assertNull(result.device)
        assertEquals("<html></html>", result.domHtml)
        assertTrue(driver.setViewportCalls.isNotEmpty())  // RESIZE_VIEWPORT present
    }

    @Test
    fun `native path takes one screenshot and skips js, dom, element map`() = runTest {
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(isNative = true, isMobile = true, platformName = "iOS 17", deviceName = "iPhone 15", browserName = "appium-ios"),
            onTakeScreenshot = { byteArrayOf(9) },
        )
        val result = CaptureEngine(driver).capture("native", CheckpointOptions(), vp)
        assertEquals(1, driver.screenshotCount)
        assertEquals(byteArrayOf(9).toList(), result.pngBytes.toList())
        assertNull(result.domHtml)
        assertNull(result.elementMapJson)
        assertEquals("appium-ios", result.browser)
        assertEquals("iOS 17", result.os)
        assertEquals("iPhone 15", result.device)
        assertTrue(driver.executedScripts.isEmpty())   // no JS on native
        assertTrue(driver.setViewportCalls.isEmpty())  // no RESIZE_VIEWPORT feature
    }

    @Test
    fun `viewport is not resized when the driver lacks RESIZE_VIEWPORT`() = runTest {
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(browserName = "fixed", features = setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT)),
            onTakeScreenshot = { byteArrayOf(1) },
            onExecuteScript = { _, _ -> null },
        )
        CaptureEngine(driver).capture("x", CheckpointOptions(sendDom = false), vp)
        assertTrue(driver.setViewportCalls.isEmpty())
    }

    @Test
    fun `beforeCaptureScreenshot hook runs on the web path`() = runTest {
        val driver = webDriver()
        CaptureEngine(driver).capture("h", CheckpointOptions(beforeCaptureScreenshot = "window.__hook=1;"), vp)
        assertTrue(driver.executedScripts.any { it == "window.__hook=1;" })
    }
}
