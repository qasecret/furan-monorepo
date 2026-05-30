package io.furan.sdk.selenium

import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

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

/**
 * Compose a list of `(y, pngBytes)` tiles into a single PNG of dimensions
 * [width] x [height]. Each tile is decoded via [ImageIO.read] and painted
 * at the (0, y) position via `Graphics2D.drawImage`. Tiles are drawn in
 * list order; later tiles overpaint earlier ones in any overlap region.
 *
 * Peak heap during compose: one composed image (width * height * 4 bytes)
 * + one decoded tile (each tile is decoded and released for GC inside
 * the loop).
 *
 * The composed image uses [BufferedImage.TYPE_INT_ARGB]; this matches
 * what the JVM's PNG encoder writes for any RGBA-capable input. The
 * resulting PNG round-trips losslessly.
 */
internal fun composeTilesIntoPng(
    tiles: List<Pair<Int, ByteArray>>,
    width: Int,
    height: Int,
): ByteArray {
    require(width > 0 && height > 0) {
        "composed image must have positive dimensions, got ${width}x$height"
    }
    val composed = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
    val g = composed.createGraphics()
    try {
        for ((y, tileBytes) in tiles) {
            val tile = ImageIO.read(ByteArrayInputStream(tileBytes))
                ?: error("could not decode tile PNG at y=$y (bytes=${tileBytes.size})")
            g.drawImage(tile, 0, y, null)
        }
    } finally {
        g.dispose()
    }
    val out = ByteArrayOutputStream()
    ImageIO.write(composed, "png", out)
    return out.toByteArray()
}
