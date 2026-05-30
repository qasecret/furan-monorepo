package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * A rectangular region in viewport-CSS pixels.
 *
 * Optionally anchored to a CSS [selector] (Eyes-parity Tier 1.2). When
 * [selector] is non-null, the Selenium adapter resolves it via
 * `driver.findElement(By.cssSelector(selector))` at capture time; the
 * `x`/`y`/`width`/`height` then act as a fallback geometry when the
 * selector misses (e.g. element not in DOM at snapshot time). Build via
 * [Region.bySelector] when you want the locator-anchored form.
 *
 * The wire payload always carries resolved numeric coordinates — the
 * api never sees the selector. This mirrors the dashboard's ignore-region
 * editor model (`IgnoreArea.selector` in `useViewerStore.ts`).
 */
@Serializable
data class Region(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val selector: String? = null,
) {
    companion object {
        /**
         * Build a CSS-selector-anchored region with placeholder geometry.
         * The Selenium adapter resolves the selector at capture time and
         * the placeholder x/y/width/height (default 0×0 at origin) are
         * overwritten with the resolved element bbox. If the selector
         * resolves to no element, capture falls back to the placeholder
         * geometry — set sensible defaults if you care.
         */
        @JvmStatic
        @JvmOverloads
        fun bySelector(
            css: String,
            fallbackX: Double = 0.0,
            fallbackY: Double = 0.0,
            fallbackWidth: Double = 0.0,
            fallbackHeight: Double = 0.0,
        ): Region = Region(
            x = fallbackX,
            y = fallbackY,
            width = fallbackWidth,
            height = fallbackHeight,
            selector = css,
        )
    }
}

@Serializable
data class FloatingRegion(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val maxUpOffset: Double = 0.0,
    val maxDownOffset: Double = 0.0,
    val maxLeftOffset: Double = 0.0,
    val maxRightOffset: Double = 0.0,
)

@Serializable
enum class AccessibilityType {
    LargeText, RegularText, BoldText, GraphicalObject
}

@Serializable
data class AccessibilityRegion(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val type: AccessibilityType,
)
