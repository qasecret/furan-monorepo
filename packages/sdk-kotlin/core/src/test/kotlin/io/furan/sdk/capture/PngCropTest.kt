package io.furan.sdk.capture

import io.furan.sdk.dto.Region
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class PngCropTest {
    @Test
    fun `crops a centered region exactly`() {
        val src = solidPng(width = 100, height = 80, color = Color.RED)
        val out = cropPng(src, Region(x = 20.0, y = 10.0, width = 40.0, height = 30.0))
        val img = ImageIO.read(ByteArrayInputStream(out))
        assertEquals(40, img.width)
        assertEquals(30, img.height)
        // Centre pixel should still be red — no transform, just crop.
        assertEquals(Color.RED.rgb, img.getRGB(20, 15))
    }

    @Test
    fun `clamps a region that overshoots the right edge`() {
        val src = solidPng(width = 100, height = 80, color = Color.BLUE)
        val out = cropPng(src, Region(x = 80.0, y = 0.0, width = 50.0, height = 30.0))
        val img = ImageIO.read(ByteArrayInputStream(out))
        // 80 + 50 = 130 > 100, so width clamps to 100 - 80 = 20.
        assertEquals(20, img.width)
        assertEquals(30, img.height)
    }

    @Test
    fun `clamps a region that overshoots the bottom edge`() {
        val src = solidPng(width = 100, height = 80, color = Color.GREEN)
        val out = cropPng(src, Region(x = 0.0, y = 70.0, width = 40.0, height = 50.0))
        val img = ImageIO.read(ByteArrayInputStream(out))
        // 70 + 50 = 120 > 80, so height clamps to 80 - 70 = 10.
        assertEquals(40, img.width)
        assertEquals(10, img.height)
    }

    @Test
    fun `negative origin coerces to zero`() {
        val src = solidPng(width = 100, height = 80, color = Color.MAGENTA)
        val out = cropPng(src, Region(x = -10.0, y = -5.0, width = 30.0, height = 20.0))
        val img = ImageIO.read(ByteArrayInputStream(out))
        // x/y coerced to 0,0 — region width/height stay so the crop starts at origin.
        assertEquals(30, img.width)
        assertEquals(20, img.height)
    }

    @Test
    fun `throws when region origin is fully outside image`() {
        val src = solidPng(width = 100, height = 80, color = Color.YELLOW)
        val ex = assertThrows(IllegalArgumentException::class.java) {
            cropPng(src, Region(x = 150.0, y = 0.0, width = 20.0, height = 20.0))
        }
        assert(ex.message!!.contains("outside image bounds"))
    }

    @Test
    fun `throws when region has non-positive dimensions`() {
        val src = solidPng(width = 100, height = 80, color = Color.CYAN)
        assertThrows(IllegalArgumentException::class.java) {
            cropPng(src, Region(x = 0.0, y = 0.0, width = 0.0, height = 20.0))
        }
        assertThrows(IllegalArgumentException::class.java) {
            cropPng(src, Region(x = 0.0, y = 0.0, width = 20.0, height = -5.0))
        }
    }

    @Test
    fun `errors when PNG bytes are undecodable`() {
        val notAPng = ByteArray(16) { 0x00 }
        assertThrows(IllegalStateException::class.java) {
            cropPng(notAPng, Region(x = 0.0, y = 0.0, width = 10.0, height = 10.0))
        }
    }
}

private fun solidPng(width: Int, height: Int, color: Color): ByteArray {
    val img = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
    val g = img.createGraphics()
    g.color = color
    g.fillRect(0, 0, width, height)
    g.dispose()
    val out = ByteArrayOutputStream()
    ImageIO.write(img, "png", out)
    return out.toByteArray()
}
