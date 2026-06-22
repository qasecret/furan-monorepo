package io.furan.sdk.images

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.Base64
import javax.imageio.ImageIO

class ImageNormalizerTest {

    private fun pngBytes(w: Int, h: Int): ByteArray {
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = Color.RED
        g.fillRect(0, 0, w, h)
        g.dispose()
        val out = ByteArrayOutputStream()
        ImageIO.write(img, "png", out)
        return out.toByteArray()
    }

    @Test
    fun `PNG bytes pass through unchanged with dimensions read from IHDR`() {
        val bytes = pngBytes(123, 45)
        val n = ImageNormalizer.normalize(bytes)
        assertEquals(123, n.width)
        assertEquals(45, n.height)
        assertTrue(bytes.contentEquals(n.pngBytes))
    }

    @Test
    fun `BufferedImage is encoded to PNG with its dimensions`() {
        val n = ImageNormalizer.normalize(BufferedImage(20, 10, BufferedImage.TYPE_INT_RGB))
        assertEquals(20, n.width)
        assertEquals(10, n.height)
        assertEquals(0x89.toByte(), n.pngBytes[0]) // PNG signature first byte
    }

    @Test
    fun `non-PNG bytes are re-encoded to PNG`() {
        val jpg = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB), "jpg", jpg)
        val n = ImageNormalizer.normalize(jpg.toByteArray())
        assertEquals(8, n.width)
        assertEquals(0x89.toByte(), n.pngBytes[0]) // now PNG
    }

    @Test
    fun `File input is read and normalized`() {
        val file = Files.createTempFile("furan", ".png").toFile()
        file.writeBytes(pngBytes(30, 31))
        file.deleteOnExit()
        val n = ImageNormalizer.normalize(file)
        assertEquals(30, n.width)
        assertEquals(31, n.height)
    }

    @Test
    fun `base64 string is decoded and normalized`() {
        val b64 = Base64.getEncoder().encodeToString(pngBytes(16, 17))
        val n = ImageNormalizer.normalizeBase64(b64)
        assertEquals(16, n.width)
        assertEquals(17, n.height)
    }

    @Test
    fun `corrupt bytes throw IllegalArgumentException`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            ImageNormalizer.normalize(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9))
        }
        assertTrue(ex.message!!.contains("image"))
    }
}
