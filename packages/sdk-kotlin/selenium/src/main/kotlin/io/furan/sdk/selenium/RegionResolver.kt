package io.furan.sdk.selenium

import io.furan.sdk.dto.Region
import org.openqa.selenium.By
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.selenium.RegionResolver")

/**
 * Resolve a [Region] with a [Region.selector] to its current bbox on the
 * page, using `driver.findElement(By.cssSelector(...))`. Returns a copy
 * of the region with x/y/width/height overwritten from the element's
 * rect.
 *
 * If the region has no selector, returns it unchanged. If the selector
 * fails to resolve (no element, stale element), logs a warning and
 * returns the original region with its fallback geometry — matches Eyes'
 * tolerant behavior where a misanchored region falls back to its
 * declared coords rather than failing the whole snapshot.
 */
internal fun resolveRegion(driver: WebDriver, region: Region): Region {
    val css = region.selector ?: return region
    return try {
        val element = driver.findElement(By.cssSelector(css))
        val rect = element.rect
        region.copy(
            x = rect.x.toDouble(),
            y = rect.y.toDouble(),
            width = rect.width.toDouble(),
            height = rect.height.toDouble(),
        )
    } catch (e: NoSuchElementException) {
        log.warn(
            "selector {} did not match any element; using fallback geometry ({},{},{}x{})",
            css, region.x, region.y, region.width, region.height,
        )
        region
    } catch (e: Exception) {
        log.warn("selector {} resolution failed ({}); using fallback geometry", css, e.message)
        region
    }
}

/**
 * Capture only the bytes inside the element matched by [css]. Uses
 * Selenium's [WebElement.getScreenshotAs] which most drivers (Chrome,
 * Firefox, Edge) implement natively without scroll-stitching. Throws
 * [NoSuchElementException] when the selector misses — element-direct
 * capture has no fallback because the caller asked for that specific
 * element.
 */
internal fun captureElementScreenshot(driver: WebDriver, css: String): ByteArray {
    val element: WebElement = driver.findElement(By.cssSelector(css))
    return element.getScreenshotAs(OutputType.BYTES)
        ?: error("element.getScreenshotAs returned null for selector $css")
}
