package io.furan.sdk.images

import io.furan.sdk.dto.AccessibilitySettings
import io.furan.sdk.dto.FloatingRegion
import io.furan.sdk.dto.MatchLevel
import io.furan.sdk.dto.Region

/**
 * Per-checkpoint options for the driverless image API
 * ([io.furan.sdk.images.FuranImages]). Slim by design: every driver-only /
 * capture-time knob from the Selenium adapter's `CheckpointOptions`
 * (`fully`, `lazyLoad`, `beforeCaptureScreenshot`, `matchTimeoutMs`,
 * `hideFixedElements`, `ignoreCaret`, `sendDom`, crop `region`,
 * `elementMapJson`) is intentionally absent — none apply once you already
 * hold the final image.
 *
 * Regions must use numeric coordinates only; a selector-anchored [Region]
 * is rejected at the call site (no live DOM to resolve it against).
 *
 * [viewport]/[browser]/[os]/[device] form the baseline-identity environment
 * tuple (ADR-054). [viewport] defaults to the image's pixel dimensions and
 * [browser] defaults to `"image"`; label them to keep, e.g., Appium-iOS and
 * Playwright-chromium baselines distinct.
 *
 * [domHtml] + [accessibilitySettings] are optional: supplying DOM unlocks
 * Furan's axe accessibility pass even on a raw image (without an element map,
 * violations surface without bbox localization).
 */
data class ImageCheckpointOptions(
    val matchLevel: MatchLevel = MatchLevel.Strict,
    val ignoreRegions: List<Region> = emptyList(),
    val layoutRegions: List<Region> = emptyList(),
    val contentRegions: List<Region> = emptyList(),
    val floatingRegions: List<FloatingRegion> = emptyList(),
    val ignoreDisplacements: Boolean = false,
    val viewport: String? = null,
    val browser: String? = null,
    val os: String? = null,
    val device: String? = null,
    val domHtml: String? = null,
    val accessibilitySettings: AccessibilitySettings? = null,
)
