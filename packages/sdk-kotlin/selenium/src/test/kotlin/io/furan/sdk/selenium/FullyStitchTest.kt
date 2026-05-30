package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class FullyStitchTest {

    // --- tileYs (Task 3) -------------------------------------------------

    @Test
    fun `tileYs exact multiple — three tiles of 1000px in 3000px page`() {
        assertEquals(listOf(0, 1000, 2000), tileYs(docHeight = 3000, viewportHeight = 1000))
    }

    @Test
    fun `tileYs partial last tile — last tile clamps to docHeight - viewportHeight`() {
        // docHeight 2500, viewportH 1000:
        //   y=0    → tile 0..1000
        //   y=1000 → tile 1000..2000
        //   y=1500 → tile 1500..2500 (clamped; would overlap previous by 500)
        assertEquals(listOf(0, 1000, 1500), tileYs(docHeight = 2500, viewportHeight = 1000))
    }

    @Test
    fun `tileYs page shorter than viewport — single tile at zero`() {
        assertEquals(listOf(0), tileYs(docHeight = 600, viewportHeight = 1000))
    }

    @Test
    fun `tileYs page equal to viewport — single tile at zero`() {
        assertEquals(listOf(0), tileYs(docHeight = 1000, viewportHeight = 1000))
    }

    @Test
    fun `tileYs document height of zero returns empty list`() {
        // Defensive — should not happen in practice (a rendered page
        // always has positive height) but the math should not crash.
        assertEquals(emptyList<Int>(), tileYs(docHeight = 0, viewportHeight = 1000))
    }

    // --- composeTilesIntoPng (Task 4) -----------------------------------

    @Test
    fun `composeTilesIntoPng paints each tile at its y offset`() {
        // Two solid-colour tiles, 100x50 each. Compose into a 100x100 image.
        // Top half red, bottom half blue.
        val red = solidColourPng(width = 100, height = 50, rgb = 0xFFFF0000.toInt())
        val blue = solidColourPng(width = 100, height = 50, rgb = 0xFF0000FF.toInt())
        val composed = composeTilesIntoPng(
            tiles = listOf(0 to red, 50 to blue),
            width = 100,
            height = 100,
        )
        // Decode and spot-check pixels.
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(composed))
        assertEquals(100, img.width)
        assertEquals(100, img.height)
        // Top-half pixel is red, bottom-half pixel is blue.
        assertEquals(0xFFFF0000.toInt(), img.getRGB(50, 10))
        assertEquals(0xFF0000FF.toInt(), img.getRGB(50, 75))
    }

    @Test
    fun `composeTilesIntoPng tolerates last-tile overlap by overpainting`() {
        // Two tiles of 50px each, but the second positioned at y=30 so it
        // overlaps the first by 20px. The second tile's pixels should win
        // in the overlap band (drawImage paints over).
        val red = solidColourPng(width = 100, height = 50, rgb = 0xFFFF0000.toInt())
        val blue = solidColourPng(width = 100, height = 50, rgb = 0xFF0000FF.toInt())
        val composed = composeTilesIntoPng(
            tiles = listOf(0 to red, 30 to blue),
            width = 100,
            height = 80,
        )
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(composed))
        assertEquals(80, img.height)
        // In the overlap band (y=30..49), blue wins.
        assertEquals(0xFF0000FF.toInt(), img.getRGB(50, 40))
        // Above the overlap, red.
        assertEquals(0xFFFF0000.toInt(), img.getRGB(50, 10))
        // Below the overlap, blue.
        assertEquals(0xFF0000FF.toInt(), img.getRGB(50, 70))
    }

    /** Helper: encode a solid-colour rectangle as PNG bytes. */
    private fun solidColourPng(width: Int, height: Int, rgb: Int): ByteArray {
        val img = java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.color = java.awt.Color(rgb, true)
        g.fillRect(0, 0, width, height)
        g.dispose()
        val out = java.io.ByteArrayOutputStream()
        javax.imageio.ImageIO.write(img, "png", out)
        return out.toByteArray()
    }
}
