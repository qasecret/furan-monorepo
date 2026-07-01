package io.furan.sdk.capture

import io.furan.sdk.dto.LazyLoadOptions
import io.furan.sdk.spec.SpecDriver
import kotlinx.coroutines.delay

/**
 * Tier 2.1: scroll the page in [LazyLoadOptions.scrollLength] increments,
 * pausing for [LazyLoadOptions.waitingTimeMs] between each, until either:
 *   - the cumulative scroll equals or exceeds the document's current
 *     `scrollHeight`, OR
 *   - the cumulative scroll equals or exceeds [LazyLoadOptions.maxAmountToScroll].
 *
 * After the loop, restores `window.scrollY` to 0 so the screenshot frames
 * the top of the page (the lazy-load pass is for
 * triggering content rendering, not for changing what gets captured).
 *
 * A thrown JS error during scroll propagates so the test sees the failure
 * rather than a baseline that didn't actually exercise lazy loading.
 */
internal suspend fun runLazyLoadScroll(driver: SpecDriver, options: LazyLoadOptions) {
    var scrolled = 0
    while (scrolled < options.maxAmountToScroll) {
        val scrollHeight = (driver.executeScript("return document.documentElement.scrollHeight;") as? Number)?.toInt() ?: 0
        if (scrolled >= scrollHeight) break
        scrolled = (scrolled + options.scrollLength).coerceAtMost(options.maxAmountToScroll)
        driver.executeScript("window.scrollTo(0, arguments[0]);", scrolled)
        if (options.waitingTimeMs > 0) {
            delay(options.waitingTimeMs)
        }
    }
    // Restore top — the capture should frame the page as the user sees it
    // on first load, not at the bottom of the scroll loop.
    driver.executeScript("window.scrollTo(0, 0);")
}
