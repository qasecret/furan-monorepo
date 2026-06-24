package io.furan.sdk.appium

import io.appium.java_client.AppiumBy
import io.appium.java_client.AppiumDriver
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.openqa.selenium.By
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.WebElement

/**
 * The Appium (java-client) implementation of [SpecDriver], for NATIVE mobile
 * capture. `isNative = true` routes the core CaptureEngine down its degraded
 * path — one full-screen screenshot, no DOM / element-map, regions passed
 * through with their declared geometry — so this adapter needs no JavaScript
 * bridge and no image logic of its own.
 *
 * Webview-context capture (switching to the full web pipeline) and native
 * element → bbox region resolution (`Feature.NATIVE_ELEMENTS`) are deliberate
 * follow-ups; see the Phase 3 spec.
 */
class AppiumSpecDriver(private val driver: AppiumDriver) : SpecDriver {

    override fun getDriverInfo(): DriverInfo {
        val caps = driver.capabilities
        val platform = caps.getCapability("platformName")?.toString()
        val device = (caps.getCapability("deviceName") ?: caps.getCapability("udid"))?.toString()
        return DriverInfo(
            isNative = true,
            isMobile = true,
            // Env tuple (ADR-054): the platform rides in the browser label
            // (mirrors playwright-<type>) so Android and iOS keep separate
            // baselines; device is populated; os is left null like the web
            // adapters (no OS-version baseline fragmentation in the MVP).
            browserName = "appium-" + (platform?.lowercase() ?: "unknown"),
            deviceName = device,
            features = emptySet(),
        )
    }

    override fun takeScreenshot(): ByteArray = driver.getScreenshotAs(OutputType.BYTES)

    override fun executeScript(script: String, vararg args: Any?): Any? =
        throw UnsupportedOperationException(
            "Appium native context has no engine JavaScript; the CaptureEngine does not call " +
                "executeScript when DriverInfo.isNative. Webview JS is a follow-up.",
        )

    override fun setViewportSize(size: Size): Unit =
        throw UnsupportedOperationException(
            "the mobile viewport is fixed; RESIZE_VIEWPORT is not advertised, so the engine " +
                "never calls setViewportSize on the native Appium adapter",
        )

    override fun findElement(selector: Selector): SpecElement? =
        try {
            AppiumSpecElement(driver.findElement(appiumBy(selector)))
        } catch (e: NoSuchElementException) {
            null
        }
}

/** Translate a Furan [Selector] to an Appium / Selenium [By] for the native UI tree. */
internal fun appiumBy(selector: Selector): By = when (selector) {
    is Selector.AccessibilityId -> AppiumBy.accessibilityId(selector.value)
    is Selector.Xpath -> By.xpath(selector.value)
    is Selector.Css ->
        error("Appium native context has no CSS engine; use Selector.AccessibilityId or Selector.Xpath")
}

private class AppiumSpecElement(private val element: WebElement) : SpecElement {
    override fun boundingRect(): Rect {
        val r = element.rect
        return Rect(r.x, r.y, r.width, r.height)
    }

    override fun elementScreenshot(): ByteArray = element.getScreenshotAs(OutputType.BYTES)
}
