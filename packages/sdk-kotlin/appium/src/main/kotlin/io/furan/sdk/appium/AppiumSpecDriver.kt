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
class AppiumSpecDriver(
    // Bound to AppiumDriver — the framework's main driver type and the base of
    // AndroidDriver / IOSDriver — rather than a narrower Selenium interface: it
    // is the type users already hold, and it keeps "this is an Appium session"
    // explicit (a bare WebDriver would also accept a desktop browser).
    private val driver: AppiumDriver,
) : SpecDriver {

    override fun getDriverInfo(): DriverInfo {
        val caps = driver.capabilities
        // Appium capabilities are usually vendor-prefixed (`appium:deviceName`);
        // some are echoed back unprefixed. Read both, and treat blank as absent.
        fun cap(name: String): String? =
            (caps.getCapability(name) ?: caps.getCapability("appium:$name"))
                ?.toString()?.takeIf { it.isNotBlank() }

        val platform = cap("platformName")
        return DriverInfo(
            isNative = true,
            isMobile = true,
            // Env tuple (ADR-054): the platform rides in the browser label
            // (mirrors playwright-<type>) so Android and iOS keep separate
            // baselines; device is populated; os is left null like the web
            // adapters. A genuinely absent platformName collapses to
            // "appium-unknown" — a misconfigured-session edge, not the norm.
            browserName = "appium-" + (platform?.lowercase() ?: "unknown"),
            deviceName = cap("deviceName") ?: cap("udid"),
            features = emptySet(),
        )
    }

    override fun takeScreenshot(): ByteArray = driver.getScreenshotAs(OutputType.BYTES)

    override fun executeScript(script: String, vararg args: Any?): Any? =
        throw UnsupportedOperationException(
            "Appium native context has no engine JavaScript; the CaptureEngine does not call " +
                "executeScript when DriverInfo.isNative (locked by CaptureEngineTest). Webview JS is a follow-up.",
        )

    override fun setViewportSize(size: Size): Unit =
        throw UnsupportedOperationException(
            "the mobile viewport is fixed; RESIZE_VIEWPORT is not advertised, so the engine " +
                "never calls setViewportSize on the native Appium adapter",
        )

    // SPI-complete and unit-tested, but NOT exercised by the native capture path
    // today: the engine resolves selector regions only on the JS/web path
    // (verified in CaptureEngineTest). Reserved for the Feature.NATIVE_ELEMENTS
    // follow-up that will resolve native selectors to bboxes.
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
        // element.rect is in the driver's logical units. When native selector
        // resolution lands (Feature.NATIVE_ELEMENTS), a HiDPI / Retina device
        // returns screenshots in device pixels, so the resolver must scale this
        // rect by the screen/screenshot ratio before cropping.
        val r = element.rect
        return Rect(r.x, r.y, r.width, r.height)
    }

    override fun elementScreenshot(): ByteArray =
        element.getScreenshotAs(OutputType.BYTES)
            ?: error("element.getScreenshotAs returned null")
}
