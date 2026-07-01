package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * Per-test ignore region. Carried on [CreateRunRequest] so SDK
 * consumers can declare ignore regions at run-create time and the
 * diff worker picks them up on the first diff job — no separate
 * round-trip plus diff-worker re-enqueue.
 *
 * The `IgnoreAreas` wire shape, verbatim except
 * for the optional `viewport` field, which lets multi-viewport runs
 * apply the right mask per screenshot. Coordinates are in image-pixel
 * space matching the screenshot dimensions; the diff worker re-applies
 * viewport filtering at diff time.
 *
 * ```
 * Furan(driver, config).use { furan ->
 *     val result = furan.snapshotAndAwait(
 *         name = "checkout-page",
 *         ignoreAreas = listOf(
 *             IgnoreArea(x = 0, y = 0, width = 200, height = 40),     // top banner
 *             IgnoreArea(x = 100, y = 500, width = 80, height = 24,   // timer widget
 *                        viewport = "1280x720"),
 *         ),
 *         diffTolerance = 0.005,                                       // 0.5%
 *     )
 * }
 * ```
 */
@Serializable
data class IgnoreArea(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    /**
     * Viewport tag (e.g. `"1280x720"`) so multi-viewport runs apply
     * the right mask to the right screenshot. Null = applies to every
     * viewport.
     */
    val viewport: String? = null,
) {
    init {
        require(x >= 0) { "IgnoreArea.x must be >= 0 (got $x)" }
        require(y >= 0) { "IgnoreArea.y must be >= 0 (got $y)" }
        require(width >= 1) { "IgnoreArea.width must be >= 1 (got $width)" }
        require(height >= 1) { "IgnoreArea.height must be >= 1 (got $height)" }
    }
}
