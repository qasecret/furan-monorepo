package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
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

    // --- captureFullyPage (Task 5) --------------------------------------

    @Test
    fun `captureFullyPage produces a PNG of width x docHeight`() = kotlinx.coroutines.runBlocking {
        // Document is 1000x600; viewport is 1000x300. Expect tileYs(600,300)=[0,300].
        // Composed image = 1000x600.
        val driver = StitchDriver(
            docWidth = 1000, docHeight = 600,
            viewportWidth = 1000, viewportHeight = 300,
        )
        val png = captureFullyPage(driver, viewportWidth = 1000, viewportHeight = 300)
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(png))
        assertEquals(1000, img.width)
        assertEquals(600, img.height)
        // The driver was told to scroll to y=0 and y=300 (the two tiles),
        // then restored to 0.
        assertEquals(listOf(0, 300, 0), driver.scrolledTo)
    }

    @Test
    fun `captureFullyPage on a short page captures a single viewport tile`() = kotlinx.coroutines.runBlocking {
        val driver = StitchDriver(
            docWidth = 800, docHeight = 400,
            viewportWidth = 800, viewportHeight = 1000,
        )
        val png = captureFullyPage(driver, viewportWidth = 800, viewportHeight = 1000)
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(png))
        // Composed image height = docHeight (NOT viewport — for a short
        // page we still trim to docHeight, otherwise the bottom of the
        // stitched image is empty/transparent).
        assertEquals(400, img.height)
        // Single scrollTo(0) + restore-to-zero (which is the same call).
        assertEquals(listOf(0, 0), driver.scrolledTo)
    }

    @Test
    fun `captureFullyPage truncates at 200 megapixel cap`() = kotlinx.coroutines.runBlocking {
        // docW=2000, requested docH would push past 200_000_000 / 2000 = 100_000.
        val driver = StitchDriver(
            docWidth = 2000, docHeight = 150_000,
            viewportWidth = 2000, viewportHeight = 1000,
        )
        val png = captureFullyPage(driver, viewportWidth = 2000, viewportHeight = 1000)
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(png))
        // Truncated to 100_000.
        assertEquals(100_000, img.height)
    }

    // --- enforceMemoryCap (direct unit tests) ---------------------------

    @Test
    fun `enforceMemoryCap returns docHeight unchanged below warn threshold`() {
        // 1920 x 20_000 = 38.4 MP, below the 50 MP warn threshold.
        assertEquals(20_000, enforceMemoryCap(docWidth = 1920, docHeight = 20_000))
    }

    @Test
    fun `enforceMemoryCap returns docHeight unchanged in warn band`() {
        // 1920 x 30_000 = 57.6 MP, above warn (50 MP) but below hard cap (200 MP).
        // Returns the original height; the warn is a side-effect log only.
        assertEquals(30_000, enforceMemoryCap(docWidth = 1920, docHeight = 30_000))
    }

    @Test
    fun `enforceMemoryCap truncates docHeight above hard cap`() {
        // 2000 x 150_000 = 300 MP, above the 200 MP hard cap.
        // Truncates to 200_000_000 / 2000 = 100_000.
        assertEquals(100_000, enforceMemoryCap(docWidth = 2000, docHeight = 150_000))
    }

    // --- warnMatchTimeoutIgnoredInFullyMode (Task 6) --------------------

    @Test
    fun `warnMatchTimeoutIgnoredInFullyMode logs once per process`() {
        // Two calls in the same process — only one log should be emitted.
        // We verify via the boolean return value the gate uses; the actual
        // log output is a side effect we don't capture here.
        // Reset the flag for test isolation.
        resetMatchTimeoutFullyWarnedForTest()
        assertTrue(warnMatchTimeoutIgnoredInFullyMode())
        assertFalse(warnMatchTimeoutIgnoredInFullyMode())
    }

    /**
     * Stub driver for the orchestrator tests. Reports a synthetic
     * `documentElement.scrollHeight` + `clientWidth`, returns a solid-blue
     * PNG of viewport size on `getScreenshotAs`. Records all scrollTo
     * arguments for assertions.
     */
    private class StitchDriver(
        private val docWidth: Int,
        private val docHeight: Int,
        private val viewportWidth: Int,
        private val viewportHeight: Int,
    ) : org.openqa.selenium.WebDriver,
        org.openqa.selenium.JavascriptExecutor,
        org.openqa.selenium.TakesScreenshot {

        val scrolledTo = mutableListOf<Int>()

        override fun executeScript(script: String, vararg args: Any?): Any? = when {
            script.contains("scrollHeight") -> docHeight
            script.contains("clientWidth") -> docWidth
            script.contains("scrollTo") -> {
                val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                scrolledTo.add(y)
                null
            }
            else -> null
        }

        override fun executeAsyncScript(script: String, vararg args: Any?): Any? = null

        override fun <X : Any?> getScreenshotAs(target: org.openqa.selenium.OutputType<X>): X {
            val img = java.awt.image.BufferedImage(viewportWidth, viewportHeight, java.awt.image.BufferedImage.TYPE_INT_ARGB)
            val g = img.createGraphics()
            g.color = java.awt.Color.BLUE
            g.fillRect(0, 0, viewportWidth, viewportHeight)
            g.dispose()
            val out = java.io.ByteArrayOutputStream()
            javax.imageio.ImageIO.write(img, "png", out)
            @Suppress("UNCHECKED_CAST")
            return out.toByteArray() as X
        }

        override fun get(url: String) = Unit
        override fun getCurrentUrl(): String = ""
        override fun getTitle(): String = ""
        override fun findElements(by: org.openqa.selenium.By): List<org.openqa.selenium.WebElement> = emptyList()
        override fun findElement(by: org.openqa.selenium.By): org.openqa.selenium.WebElement = throw NotImplementedError()
        override fun getPageSource(): String = ""
        override fun close() = Unit
        override fun quit() = Unit
        override fun getWindowHandles(): Set<String> = emptySet()
        override fun getWindowHandle(): String = ""
        override fun switchTo(): org.openqa.selenium.WebDriver.TargetLocator = throw NotImplementedError()
        override fun navigate(): org.openqa.selenium.WebDriver.Navigation = throw NotImplementedError()
        override fun manage(): org.openqa.selenium.WebDriver.Options = throw NotImplementedError()
    }
}
