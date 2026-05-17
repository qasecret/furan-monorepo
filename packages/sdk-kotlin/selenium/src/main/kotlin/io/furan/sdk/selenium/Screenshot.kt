package io.furan.sdk.selenium

import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver

/**
 * Captures a viewport-sized screenshot. Returns PNG bytes.
 *
 * Selenium 4.x's `TakesScreenshot` is viewport-only by default; full-page
 * screenshots require browser-specific extensions (Chrome DevTools Protocol,
 * Firefox `--full-page`). v0.5 captures viewport-only; full-page is deferred
 * to v0.6/v1.1+ if dogfood asks.
 */
internal fun captureScreenshot(driver: WebDriver): ByteArray {
    val taker = driver as? TakesScreenshot
        ?: error("WebDriver does not implement TakesScreenshot; cannot capture screenshot")
    return taker.getScreenshotAs(OutputType.BYTES)
}
