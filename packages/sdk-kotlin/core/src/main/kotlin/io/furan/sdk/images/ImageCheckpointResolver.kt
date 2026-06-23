package io.furan.sdk.images

import io.furan.sdk.Regions
import io.furan.sdk.dto.MatchLevel

/** The exact argument set [io.furan.sdk.FuranClient.createScreenshot] needs, fully resolved. */
class ResolvedImageCheckpoint internal constructor(
    val name: String,
    val viewport: String,
    val browser: String,
    val os: String?,
    val device: String?,
    val matchLevel: MatchLevel,
    val regions: Regions,
    val pngBytes: ByteArray,
    val domHtml: String?,
    val elementMapJson: String?,
    val ignoreDisplacements: Boolean,
    val accessibilityLevel: String?,
    val accessibilityVersion: String?,
)

/**
 * Pure mapping from ([ImageCheckpointOptions] + [NormalizedImage]) to the
 * resolved `createScreenshot` arguments. Network-free; this is where the
 * driverless defaults and validation live.
 */
object ImageCheckpointResolver {

    /** Default environment-tuple browser label when the caller does not set one. */
    const val DEFAULT_BROWSER = "image"

    fun resolve(
        name: String,
        options: ImageCheckpointOptions,
        image: NormalizedImage,
    ): ResolvedImageCheckpoint {
        rejectSelectorRegions(options)
        requireDomForAccessibility(options)
        return ResolvedImageCheckpoint(
            name = name,
            viewport = options.viewport ?: "${image.width}x${image.height}",
            browser = options.browser ?: DEFAULT_BROWSER,
            os = options.os,
            device = options.device,
            matchLevel = options.matchLevel,
            regions = Regions(
                ignore = options.ignoreRegions,
                layout = options.layoutRegions,
                floating = options.floatingRegions,
                content = options.contentRegions,
                accessibility = emptyList(),
            ),
            pngBytes = image.pngBytes,
            domHtml = options.domHtml,
            elementMapJson = null, // no driver -> no element map
            ignoreDisplacements = options.ignoreDisplacements,
            accessibilityLevel = options.accessibilitySettings?.level?.wire,
            accessibilityVersion = options.accessibilitySettings?.guidelinesVersion?.wire,
        )
    }

    private fun rejectSelectorRegions(options: ImageCheckpointOptions) {
        val offender = (options.ignoreRegions + options.layoutRegions + options.contentRegions)
            .firstOrNull { it.selector != null }
        require(offender == null) {
            "selector-anchored regions are not supported on raw images (no DOM to resolve " +
                "'${offender?.selector}'); use numeric x/y/width/height coordinates instead"
        }
    }

    private fun requireDomForAccessibility(options: ImageCheckpointOptions) {
        require(options.accessibilitySettings == null || options.domHtml != null) {
            "accessibilitySettings requires a DOM payload on the driverless image API " +
                "(there is no driver to capture one) — set ImageCheckpointOptions(domHtml = ...) " +
                "or remove accessibilitySettings"
        }
    }
}
