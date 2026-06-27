package io.furan.sdk.selenium

import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.openqa.selenium.By
import org.openqa.selenium.Dimension
import org.openqa.selenium.HasCapabilities
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

/**
 * The Selenium implementation of [SpecDriver] — the only Selenium-specific
 * code in the capture path. All capture logic lives in the engine
 * (io.furan.sdk.capture.CaptureEngine).
 *
 * [getDriverInfo] reports the real browser from the WebDriver's capabilities
 * (`browserName`, e.g. "chrome"/"firefox"), lower-cased, or null when the
 * driver exposes no capabilities — the engine then falls back to the adapter
 * name. This reverses ADR-054's "selenium" placeholder so the Browser column
 * and the baseline identity reflect the actual browser; an operator can still
 * override via FURAN_BROWSER (e.g. for a remote grid). Existing "selenium"
 * variations re-baseline once.
 */
class SeleniumSpecDriver(private val driver: WebDriver) : SpecDriver {

    override fun getDriverInfo(): DriverInfo = DriverInfo(
        isNative = false,
        isMobile = false,
        platformName = null,
        deviceName = null,
        browserName = (driver as? HasCapabilities)
            ?.capabilities
            ?.browserName
            ?.takeIf { it.isNotBlank() }
            ?.lowercase(),
        browserVersion = null,
        // Reflect what the wrapped driver can actually do rather than assuming.
        // A WebDriver that is not a JavascriptExecutor degrades to a plain
        // screenshot (the engine's no-JS path) instead of throwing on the
        // first JS call. Every mainstream browser driver is both.
        features = buildSet {
            if (driver is JavascriptExecutor) {
                add(Feature.JAVASCRIPT)
                add(Feature.DOM_SNAPSHOT)
            }
            if (driver is TakesScreenshot) {
                add(Feature.ELEMENT_SCREENSHOT)
            }
            add(Feature.RESIZE_VIEWPORT)
        },
    )

    override fun takeScreenshot(): ByteArray {
        val taker = driver as? TakesScreenshot
            ?: error("WebDriver does not implement TakesScreenshot; cannot capture screenshot")
        return taker.getScreenshotAs(OutputType.BYTES)
    }

    override fun executeScript(script: String, vararg args: Any?): Any? {
        val executor = driver as? JavascriptExecutor
            ?: error("WebDriver does not implement JavascriptExecutor; cannot execute script")
        return executor.executeScript(script, *args)
    }

    override fun setViewportSize(size: Size) {
        driver.manage().window().size = Dimension(size.width, size.height)
    }

    override fun findElement(selector: Selector): SpecElement? {
        val by = when (selector) {
            is Selector.Css -> By.cssSelector(selector.value)
            is Selector.Xpath -> By.xpath(selector.value)
            is Selector.AccessibilityId ->
                error("Selenium has no accessibility-id locator; use Selector.Css or Selector.Xpath")
        }
        return try {
            SeleniumSpecElement(driver.findElement(by))
        } catch (e: NoSuchElementException) {
            null
        }
    }
}

private class SeleniumSpecElement(private val element: WebElement) : SpecElement {
    override fun boundingRect(): Rect {
        val r = element.rect
        return Rect(r.x, r.y, r.width, r.height)
    }

    override fun elementScreenshot(): ByteArray =
        element.getScreenshotAs(OutputType.BYTES)
            ?: error("element.getScreenshotAs returned null")
}
