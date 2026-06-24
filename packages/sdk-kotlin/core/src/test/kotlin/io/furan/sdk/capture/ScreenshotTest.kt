package io.furan.sdk.capture

import io.furan.sdk.spec.Size
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

class ScreenshotTest {
    @Test
    fun `captureScreenshot returns the driver's bytes`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        val driver = FakeSpecDriver(onTakeScreenshot = { png })
        assertArrayEquals(png, captureScreenshot(driver))
    }

    @Test
    fun `pngDimensions reads width and height from the IHDR`() {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(360, 640, BufferedImage.TYPE_INT_ARGB), "png", out)
        assertEquals(Size(360, 640), pngDimensions(out.toByteArray()))
    }

    @Test
    fun `pngDimensions returns null for non-PNG or truncated bytes`() {
        assertNull(pngDimensions(byteArrayOf(9)))
        assertNull(pngDimensions(ByteArray(0)))
        assertNull(pngDimensions("definitely not a png header".toByteArray()))
    }
}
