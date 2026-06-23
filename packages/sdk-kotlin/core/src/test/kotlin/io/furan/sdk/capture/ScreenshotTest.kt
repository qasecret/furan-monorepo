package io.furan.sdk.capture

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Test

class ScreenshotTest {
    @Test
    fun `captureScreenshot returns the driver's bytes`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        val driver = FakeSpecDriver(onTakeScreenshot = { png })
        assertArrayEquals(png, captureScreenshot(driver))
    }
}
