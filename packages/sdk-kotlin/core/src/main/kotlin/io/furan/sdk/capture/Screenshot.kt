package io.furan.sdk.capture

import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver

/** Captures a viewport-sized screenshot as PNG bytes via the SPI. */
internal fun captureScreenshot(driver: SpecDriver): ByteArray = driver.takeScreenshot()

/**
 * Read a PNG's pixel dimensions straight from its IHDR header — no full decode,
 * since a device screenshot can be tens of megabytes. Returns null when [bytes]
 * is not a PNG or is truncated, so callers fall back to a declared size.
 */
internal fun pngDimensions(bytes: ByteArray): Size? {
    // 8-byte signature, then IHDR: 4-byte length + "IHDR" + 4-byte width + 4-byte height.
    if (bytes.size < 24) return null
    if (bytes[0].toInt() and 0xFF != 0x89 ||
        bytes[1].toInt() != 'P'.code || bytes[2].toInt() != 'N'.code || bytes[3].toInt() != 'G'.code
    ) {
        return null
    }
    fun be32(off: Int): Int =
        ((bytes[off].toInt() and 0xFF) shl 24) or
            ((bytes[off + 1].toInt() and 0xFF) shl 16) or
            ((bytes[off + 2].toInt() and 0xFF) shl 8) or
            (bytes[off + 3].toInt() and 0xFF)
    val width = be32(16)
    val height = be32(20)
    return if (width > 0 && height > 0) Size(width, height) else null
}
