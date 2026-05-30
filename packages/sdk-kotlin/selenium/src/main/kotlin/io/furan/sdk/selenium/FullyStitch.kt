package io.furan.sdk.selenium

import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlinx.coroutines.delay
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.selenium.FullyStitch")

/** Soft warn threshold (spec §4.5): 50 megapixels (~1920x26000). */
internal const val FULLY_WARN_MEGAPIXELS: Long = 50_000_000

/** Hard cap (spec §4.5): 200 megapixels (~1920x100000). Above this the page is truncated. */
internal const val FULLY_HARD_CAP_MEGAPIXELS: Long = 200_000_000

/**
 * Per-tile settle delay before capture (matches the empirical 50ms wait
 * Eyes uses between scroll and screenshot — gives the browser time to
 * paint after scroll without burning measurable budget).
 */
internal const val FULLY_TILE_SETTLE_MS: Long = 50

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

/**
 * Top-level orchestrator (spec §4.2). Drives the scroll-and-capture loop
 * and returns the composed PNG.
 *
 *  1. Read document width / height from JS.
 *  2. Apply memory cap (truncate effective docHeight if needed).
 *  3. Compute tile y offsets via [tileYs].
 *  4. For each y: `window.scrollTo(0, y)`, settle, capture viewport via
 *     `getScreenshotAs(BYTES)`, collect (y, bytes).
 *  5. Restore scroll to 0.
 *  6. Compose tiles via [composeTilesIntoPng].
 *  7. Return PNG bytes.
 *
 * Throws if the driver does not implement [TakesScreenshot] — a non-
 * screenshot driver cannot be used for fully-page capture.
 */
internal suspend fun captureFullyPage(
    driver: WebDriver,
    viewportWidth: Int,
    viewportHeight: Int,
): ByteArray {
    val taker = driver as? TakesScreenshot
        ?: error("WebDriver does not implement TakesScreenshot; cannot capture fully")
    val js = driver as? JavascriptExecutor
        ?: error("WebDriver does not implement JavascriptExecutor; cannot drive scroll")

    val docWidth = (
        (js.executeScript("return document.documentElement.clientWidth;") as? Number)?.toInt()
            ?: viewportWidth
        ).coerceAtLeast(viewportWidth)
    val rawDocHeight = (
        js.executeScript(
            "return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);",
        ) as? Number
        )?.toInt() ?: viewportHeight

    val effDocHeight = enforceMemoryCap(docWidth, rawDocHeight)

    val ys = tileYs(docHeight = effDocHeight, viewportHeight = viewportHeight)
    val tiles = mutableListOf<Pair<Int, ByteArray>>()
    try {
        for (y in ys) {
            js.executeScript("window.scrollTo(0, arguments[0]);", y)
            delay(FULLY_TILE_SETTLE_MS)
            tiles.add(y to taker.getScreenshotAs(OutputType.BYTES))
        }
    } finally {
        // Restore scroll to 0 even if a tile capture threw — the caller's
        // post-stitch DOM / element-bbox capture relies on scrollY=0.
        runCatching { js.executeScript("window.scrollTo(0, arguments[0]);", 0) }
    }
    check(tiles.isNotEmpty()) {
        "no tiles captured for fully-page stitch (effDocHeight=$effDocHeight, viewportHeight=$viewportHeight)"
    }
    return composeTilesIntoPng(tiles = tiles, width = docWidth, height = effDocHeight)
}

/**
 * Apply the spec §4.5 memory budget: warn above [FULLY_WARN_MEGAPIXELS],
 * truncate above [FULLY_HARD_CAP_MEGAPIXELS]. Returns the effective
 * document height (== [docHeight] if below the cap).
 */
internal fun enforceMemoryCap(docWidth: Int, docHeight: Int): Int {
    val pixels = docWidth.toLong() * docHeight.toLong()
    if (pixels > FULLY_HARD_CAP_MEGAPIXELS) {
        val cappedHeight = (FULLY_HARD_CAP_MEGAPIXELS / docWidth.toLong()).toInt()
        log.error(
            "fully-page document is {} px ({}x{}), exceeds hard cap {} px; truncating to {}x{}",
            pixels, docWidth, docHeight, FULLY_HARD_CAP_MEGAPIXELS, docWidth, cappedHeight,
        )
        return cappedHeight
    }
    if (pixels > FULLY_WARN_MEGAPIXELS) {
        log.warn(
            "fully-page document is {} px ({}x{}), above {} warn threshold; consider masking or splitting the test",
            pixels, docWidth, docHeight, FULLY_WARN_MEGAPIXELS,
        )
    }
    return docHeight
}

/**
 * Process-wide flag: have we already logged the "matchTimeoutMs ignored
 * in fully mode" notice? We only want to log it once per process — the
 * user has already seen the message and noisier logs don't help.
 */
@Volatile
private var matchTimeoutFullyWarned: Boolean = false

/**
 * Emit a one-time INFO log when both [io.furan.sdk.dto.CheckpointOptions.fully]
 * and [io.furan.sdk.dto.CheckpointOptions.matchTimeoutMs] are set on the same
 * checkpoint (spec §4.6.3). Returns true if the log was emitted (first call),
 * false otherwise (subsequent calls in the same process).
 */
internal fun warnMatchTimeoutIgnoredInFullyMode(): Boolean {
    if (matchTimeoutFullyWarned) return false
    matchTimeoutFullyWarned = true
    log.info(
        "matchTimeoutMs is ignored when CheckpointOptions.fully = true; " +
            "use lazyLoad + waitBeforeCaptureMs to settle the page before stitching",
    )
    return true
}

/** Reset the gate for unit tests. Must NOT be called from production code. */
internal fun resetMatchTimeoutFullyWarnedForTest() {
    matchTimeoutFullyWarned = false
}
