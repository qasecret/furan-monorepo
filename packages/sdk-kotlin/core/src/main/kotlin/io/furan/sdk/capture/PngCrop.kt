package io.furan.sdk.capture

import io.furan.sdk.dto.Region
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.capture.PngCrop")

/**
 * Crop a PNG to the given [region]. Coordinates are in image pixels.
 *
 * Clamps an out-of-bounds region to the image dimensions and logs a warning
 * (matches Applitools Eyes' tolerant behavior — a region that slightly
 * exceeds the viewport on a smaller screen still produces a valid crop).
 *
 * Throws [IllegalArgumentException] if the region is fully outside the
 * image (no overlap) or if either dimension clamps to ≤ 0 — both signal a
 * configuration mistake the caller wants to know about.
 */
fun cropPng(pngBytes: ByteArray, region: Region): ByteArray {
    val image: BufferedImage = ImageIO.read(ByteArrayInputStream(pngBytes))
        ?: error("could not decode PNG bytes (length=${pngBytes.size})")
    val cropped = image.crop(region)
    val out = ByteArrayOutputStream()
    ImageIO.write(cropped, "png", out)
    return out.toByteArray()
}

private fun BufferedImage.crop(region: Region): BufferedImage {
    val rx = region.x.toInt().coerceAtLeast(0)
    val ry = region.y.toInt().coerceAtLeast(0)
    val rw = region.width.toInt()
    val rh = region.height.toInt()
    require(rw > 0 && rh > 0) {
        "region must have positive width and height, got width=$rw height=$rh"
    }
    require(rx < width && ry < height) {
        "region origin ($rx,$ry) is outside image bounds (${width}x${height})"
    }
    val w = minOf(rw, width - rx)
    val h = minOf(rh, height - ry)
    if (w != rw || h != rh) {
        log.warn(
            "region ({},{},{}x{}) clamped to ({},{},{}x{}) inside image {}x{}",
            rx, ry, rw, rh, rx, ry, w, h, width, height,
        )
    }
    return getSubimage(rx, ry, w, h)
}
