package io.furan.sdk.dto

/**
 * Per-checkpoint options passed to [io.furan.sdk.selenium.Furan.snapshot].
 * Carries the match level and all five region kinds (ignore, layout,
 * floating, content, accessibility) that the diff worker uses when
 * comparing this checkpoint against its baseline.
 *
 * [domHtml] and [elementMapJson] are optional side-channels for DOM/element
 * capture; when null the SDK auto-captures from the driver.
 */
data class CheckpointOptions(
    val matchLevel: MatchLevel = MatchLevel.Strict,
    val ignoreRegions: List<Region> = emptyList(),
    val layoutRegions: List<Region> = emptyList(),
    val floatingRegions: List<FloatingRegion> = emptyList(),
    val contentRegions: List<Region> = emptyList(),
    val accessibilityRegions: List<AccessibilityRegion> = emptyList(),
    /**
     * Optional DOM HTML override. When null, the selenium adapter
     * auto-captures via `document.documentElement.outerHTML`.
     */
    val domHtml: String? = null,
    /**
     * Optional pre-serialized element-bbox JSON. When null, the selenium
     * adapter auto-captures via the ELEMENT_BBOX_SCRIPT executor.
     */
    val elementMapJson: String? = null,
)
