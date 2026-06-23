package io.furan.sdk.capture

import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.Region
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.SpecElement
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
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

    @Test
    fun `DOM and element-map are skipped when the driver lacks DOM_SNAPSHOT`() = runTest {
        // JS-capable but no DOM_SNAPSHOT: the web path runs, but DOM html and
        // the element-map must NOT be captured.
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(
                browserName = "js-no-dom",
                features = setOf(Feature.JAVASCRIPT, Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT),
            ),
            onTakeScreenshot = { byteArrayOf(1) },
            onExecuteScript = { _, _ -> "<html>should-not-be-used</html>" },
        )
        val result = CaptureEngine(driver).capture("x", CheckpointOptions(), vp)
        assertNull(result.domHtml)
        assertNull(result.elementMapJson)
        assertTrue(driver.executedScripts.none { "outerHTML" in it }) // captureDom not invoked
    }

    @Test
    fun `native path passes selector regions through without resolving them`() = runTest {
        val region = Region.bySelector(
            css = ".x", fallbackX = 7.0, fallbackY = 8.0, fallbackWidth = 9.0, fallbackHeight = 10.0,
        )
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(isNative = true, browserName = "appium"),
            onTakeScreenshot = { byteArrayOf(1) },
            // A native driver cannot resolve CSS — findElement must never be called.
            onFindElement = { throw AssertionError("native path must not resolve CSS selectors") },
        )
        val result = CaptureEngine(driver).capture(
            "n", CheckpointOptions(ignoreRegions = listOf(region), ignoreCaret = true), vp,
        )
        assertEquals(listOf(region), result.regions.ignore) // passed through unresolved, caret not appended
    }

    @Test
    fun `element-direct capture falls back to crop when the driver lacks ELEMENT_SCREENSHOT`() = runTest {
        val stable = solidPng(10, 10)
        val element = object : SpecElement {
            override fun boundingRect(): Rect = Rect(0, 0, 5, 5)
            override fun elementScreenshot(): ByteArray =
                throw AssertionError("element-direct capture must not run without ELEMENT_SCREENSHOT")
        }
        val driver = FakeSpecDriver(
            driverInfo = DriverInfo(
                browserName = "no-elem-shot",
                features = setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT, Feature.RESIZE_VIEWPORT),
            ),
            onTakeScreenshot = { stable },
            onExecuteScript = { _, _ -> null },
            onFindElement = { element },
        )
        val result = CaptureEngine(driver).capture(
            "e", CheckpointOptions(region = Region.bySelector(".target")), vp,
        )
        // Crop path produced a 5x5 image from the 10x10 stable screenshot.
        val img = ImageIO.read(ByteArrayInputStream(result.pngBytes))
        assertEquals(5, img.width)
        assertEquals(5, img.height)
    }

    private fun solidPng(width: Int, height: Int): ByteArray {
        val img = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.color = Color.BLUE
        g.fillRect(0, 0, width, height)
        g.dispose()
        val out = ByteArrayOutputStream()
        ImageIO.write(img, "png", out)
        return out.toByteArray()
    }
}
