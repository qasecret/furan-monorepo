package io.furan.sdk.images

import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import javax.imageio.ImageIO

/** A PNG byte buffer plus its pixel dimensions. */
class NormalizedImage internal constructor(
    val pngBytes: ByteArray,
    val width: Int,
    val height: Int,
)

/**
 * Converts any accepted image input into PNG bytes + dimensions. Pure and
 * network-free. PNG inputs pass through untouched (dimensions read cheaply
 * from the IHDR chunk, no full decode); non-PNG inputs are decoded and
 * re-encoded to PNG via [ImageIO].
 */
object ImageNormalizer {

    private val PNG_SIGNATURE = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    )

    fun normalize(png: ByteArray): NormalizedImage {
        require(png.isNotEmpty()) { "image bytes are empty" }
        return if (isPng(png)) {
            val (w, h) = readPngDimensions(png)
            NormalizedImage(png, w, h)
        } else {
            encode(decode(png))
        }
    }

    fun normalize(file: File): NormalizedImage {
        require(file.exists()) { "image file does not exist: ${file.path}" }
        return normalize(file.readBytes())
    }

    fun normalize(image: BufferedImage): NormalizedImage = encode(image)

    fun normalizeBase64(base64: String): NormalizedImage {
        val payload = base64.substringAfter("base64,").trim()
        val bytes = try {
            Base64.getDecoder().decode(payload)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("invalid base64 image string", e)
        }
        return normalize(bytes)
    }

    private fun isPng(bytes: ByteArray): Boolean =
        bytes.size >= PNG_SIGNATURE.size && PNG_SIGNATURE.indices.all { bytes[it] == PNG_SIGNATURE[it] }

    /** PNG IHDR: width is a big-endian uint32 at byte offset 16, height at offset 20. */
    private fun readPngDimensions(bytes: ByteArray): Pair<Int, Int> {
        require(bytes.size >= 24) { "image bytes too short to be a valid PNG" }
        return readBeInt(bytes, 16) to readBeInt(bytes, 20)
    }

    private fun readBeInt(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 0xFF) shl 24) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 8) or
            (bytes[offset + 3].toInt() and 0xFF)

    private fun decode(bytes: ByteArray): BufferedImage =
        ByteArrayInputStream(bytes).use { ImageIO.read(it) }
            ?: throw IllegalArgumentException("bytes are not a decodable image")

    private fun encode(image: BufferedImage): NormalizedImage {
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "png", out)
        return NormalizedImage(out.toByteArray(), image.width, image.height)
    }
}
