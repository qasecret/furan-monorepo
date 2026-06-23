package io.furan.sdk.capture

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class StableCaptureTest {

    @Test
    fun `timeoutMs zero returns single capture without polling`() = runTest {
        val driver = framedDriver(byteArrayOf(1, 2, 3))
        val out = captureStableScreenshot(driver, timeoutMs = 0)
        assertArrayEquals(byteArrayOf(1, 2, 3), out)
        assertEquals(1, driver.screenshotCount, "expected exactly one capture when timeoutMs=0")
    }

    @Test
    fun `timeoutMs negative returns single capture without polling`() = runTest {
        val driver = framedDriver(byteArrayOf(9))
        captureStableScreenshot(driver, timeoutMs = -100)
        assertEquals(1, driver.screenshotCount)
    }

    @Test
    fun `returns stable bytes once two consecutive captures match`() = runTest {
        // Sequence: A, B, B → samples 1, 2, 3. Sample 3 matches sample
        // 2 → return sample 3.
        val a = byteArrayOf(1)
        val b = byteArrayOf(2)
        val driver = framedDriver(a, b, b)
        val out = captureStableScreenshot(driver, timeoutMs = 1000)
        assertArrayEquals(b, out)
        // Three calls total: initial + 2 samples until match.
        assertEquals(3, driver.screenshotCount)
    }

    @Test
    fun `returns last capture when budget exhausts without stability`() = runTest {
        // Sequence keeps changing: each call returns different bytes.
        // Budget 250ms with 100ms interval → 2 sample waits → 3 total
        // captures (initial + 2 samples). Returns the final never-stable
        // capture.
        var lastReturned = ByteArray(0)
        var i = 0
        val frames = listOf(
            byteArrayOf(1),
            byteArrayOf(2),
            byteArrayOf(3),
            byteArrayOf(4), // extra to satisfy any off-by-one
        )
        val driver = FakeSpecDriver(onTakeScreenshot = {
            val frame = frames[i.coerceAtMost(frames.size - 1)]
            i++
            lastReturned = frame
            frame
        })
        val out = captureStableScreenshot(driver, timeoutMs = 250)
        // Last-used array depends on exact iteration count; just assert
        // it's one of the late entries and at least 2 samples were taken.
        assertTrue(driver.screenshotCount >= 3, "expected at least 3 captures, got ${driver.screenshotCount}")
        assertArrayEquals(lastReturned, out)
    }

    @Test
    fun `stability detected on first poll (bytes already match)`() = runTest {
        // Initial and sample 2 are identical → stable immediately on
        // the first poll. Two total captures.
        val a = byteArrayOf(7, 7, 7)
        val driver = framedDriver(a, a, a)
        val out = captureStableScreenshot(driver, timeoutMs = 1000)
        assertArrayEquals(a, out)
        assertEquals(2, driver.screenshotCount)
    }
}

private fun framedDriver(vararg frames: ByteArray): FakeSpecDriver {
    var i = 0
    return FakeSpecDriver(onTakeScreenshot = {
        val frame = frames[i.coerceAtMost(frames.size - 1)]; i++; frame
    })
}
