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
 * [getDriverInfo] deliberately reports `browserName = "selenium"` (not the
 * real browser) so the engine reproduces today's hardcoded environment
 * tuple and existing baselines keep matching (ADR-054). See the plan's
 * behavior-preservation invariant 1.
 */
class SeleniumSpecDriver(private val driver: WebDriver) : SpecDriver {

    override fun getDriverInfo(): DriverInfo = DriverInfo(
        isNative = false,
        isMobile = false,
        platformName = null,
        deviceName = null,
        browserName = "selenium",
        browserVersion = null,
        features = setOf(
            Feature.JAVASCRIPT,
            Feature.DOM_SNAPSHOT,
            Feature.RESIZE_VIEWPORT,
            Feature.ELEMENT_SCREENSHOT,
        ),
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

    override fun getViewportSize(): Size {
        val d = driver.manage().window().size
        return Size(d.width, d.height)
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

    override fun navigate(url: String) {
        driver.get(url)
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
