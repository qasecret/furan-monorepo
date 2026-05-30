package io.furan.sdk.selenium

/**
 * Tier 3 — full-page stitching.
 *
 * This file is split into three logical parts, each developed
 * independently:
 *
 *  1. [tileYs] — pure math: where each tile's top edge sits.
 *  2. composeTilesIntoPng (Task 4) — paint decoded tiles into a single
 *     `BufferedImage` and encode as PNG.
 *  3. captureFullyPage (Task 5) — orchestrator: drive scroll + capture
 *     loop, enforce memory cap, return PNG bytes.
 */

/**
 * Return the list of `y` offsets at which to capture each tile, given a
 * document of [docHeight] pixels and a viewport of [viewportHeight]
 * pixels.
 *
 *  - First tile always starts at 0.
 *  - Each subsequent tile starts `viewportHeight` below the previous.
 *  - The last tile is clamped to `docHeight - viewportHeight` so its
 *    bottom edge sits exactly at `docHeight`. This may produce a small
 *    overlap with the previous tile; the compose step overpaints
 *    identical pixels in the overlap region (no-op).
 *  - If [docHeight] <= [viewportHeight], a single tile at 0 covers the
 *    whole page.
 *  - If [docHeight] is non-positive, returns an empty list (defensive;
 *    a rendered page always has positive height).
 */
internal fun tileYs(docHeight: Int, viewportHeight: Int): List<Int> {
    require(viewportHeight > 0) { "viewportHeight must be positive, was $viewportHeight" }
    if (docHeight <= 0) return emptyList()
    if (docHeight <= viewportHeight) return listOf(0)
    val ys = mutableListOf<Int>()
    var y = 0
    while (y + viewportHeight < docHeight) {
        ys.add(y)
        y += viewportHeight
    }
    // Clamp the last tile so its bottom edge sits at docHeight.
    ys.add(docHeight - viewportHeight)
    return ys
}
