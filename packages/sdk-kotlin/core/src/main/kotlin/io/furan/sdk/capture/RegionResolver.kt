package io.furan.sdk.capture

import io.furan.sdk.dto.Region
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.SpecDriver
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.capture.RegionResolver")

/**
 * Resolve a [Region] carrying a [Region.selector] to its current bbox via
 * the SPI. A selector-less region passes through unchanged. A selector that
 * matches nothing (null element) or fails to read its rect (stale) falls
 * back to the region's declared geometry — Eyes-tolerant behavior.
 */
fun resolveRegion(driver: SpecDriver, region: Region): Region {
    val css = region.selector ?: return region
    val element = driver.findElement(Selector.Css(css))
    if (element == null) {
        log.warn(
            "selector {} did not match any element; using fallback geometry ({},{},{}x{})",
            css, region.x, region.y, region.width, region.height,
        )
        return region
    }
    return try {
        val rect = element.boundingRect()
        region.copy(
            x = rect.x.toDouble(),
            y = rect.y.toDouble(),
            width = rect.width.toDouble(),
            height = rect.height.toDouble(),
        )
    } catch (e: Exception) {
        log.warn("selector {} resolution failed ({}); using fallback geometry", css, e.message)
        region
    }
}

/**
 * Capture only the bytes inside the element matched by [css] via the SPI's
 * element-direct screenshot. Throws when the selector misses — the caller
 * asked for that specific element, so there is no fallback.
 */
fun captureElementScreenshot(driver: SpecDriver, css: String): ByteArray {
    val element = driver.findElement(Selector.Css(css))
        ?: error("no element matched selector $css for element-direct capture")
    return element.elementScreenshot()
}
