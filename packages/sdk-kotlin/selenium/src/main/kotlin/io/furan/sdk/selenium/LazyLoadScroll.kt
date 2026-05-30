package io.furan.sdk.selenium

import io.furan.sdk.dto.LazyLoadOptions
import kotlinx.coroutines.delay
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.selenium.LazyLoadScroll")

/**
 * Tier 2.1: scroll the page in [LazyLoadOptions.scrollLength] increments,
 * pausing for [LazyLoadOptions.waitingTimeMs] between each, until either:
 *   - the cumulative scroll equals or exceeds the document's current
 *     `scrollHeight`, OR
 *   - the cumulative scroll equals or exceeds [LazyLoadOptions.maxAmountToScroll].
 *
 * After the loop, restores `window.scrollY` to 0 so the screenshot frames
 * the top of the page (matches Eyes' behavior — the lazy-load pass is for
 * triggering content rendering, not for changing what gets captured).
 *
 * Silently no-ops on a non-JS driver (returns early). A thrown JS error
 * during scroll propagates so the test sees the failure rather than a
 * baseline that didn't actually exercise lazy loading.
 */
internal suspend fun runLazyLoadScroll(driver: WebDriver, options: LazyLoadOptions) {
    val js = driver as? JavascriptExecutor ?: run {
        log.debug("driver is not a JavascriptExecutor; skipping lazy-load scroll")
        return
    }
    var scrolled = 0
    while (scrolled < options.maxAmountToScroll) {
        // Re-read scrollHeight each iteration because lazy-loaded content
        // typically *grows* the document — the bound moves as we scroll.
        val scrollHeight = (js.executeScript("return document.documentElement.scrollHeight;") as? Number)?.toInt() ?: 0
        if (scrolled >= scrollHeight) break
        scrolled = (scrolled + options.scrollLength).coerceAtMost(options.maxAmountToScroll)
        js.executeScript("window.scrollTo(0, arguments[0]);", scrolled)
        if (options.waitingTimeMs > 0) {
            delay(options.waitingTimeMs)
        }
    }
    // Restore top — the capture should frame the page as the user sees it
    // on first load, not at the bottom of the scroll loop.
    js.executeScript("window.scrollTo(0, 0);")
}
