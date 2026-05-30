package io.furan.sdk.selenium

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class StableCaptureTest {

    @Test
    fun `timeoutMs zero returns single capture without polling`() = runBlocking {
        val driver = SequenceShotDriver(listOf(byteArrayOf(1, 2, 3)))
        val out = captureStableScreenshot(driver, timeoutMs = 0)
        assertArrayEquals(byteArrayOf(1, 2, 3), out)
        assertEquals(1, driver.calls, "expected exactly one capture when timeoutMs=0")
    }

    @Test
    fun `timeoutMs negative returns single capture without polling`() = runBlocking {
        val driver = SequenceShotDriver(listOf(byteArrayOf(9)))
        captureStableScreenshot(driver, timeoutMs = -100)
        assertEquals(1, driver.calls)
    }

    @Test
    fun `returns stable bytes once two consecutive captures match`() = runBlocking {
        // Sequence: A, B, B → samples 1, 2, 3. Sample 3 matches sample
        // 2 → return sample 3.
        val a = byteArrayOf(1)
        val b = byteArrayOf(2)
        val driver = SequenceShotDriver(listOf(a, b, b))
        val out = captureStableScreenshot(driver, timeoutMs = 1000)
        assertArrayEquals(b, out)
        // Three calls total: initial + 2 samples until match.
        assertEquals(3, driver.calls)
    }

    @Test
    fun `returns last capture when budget exhausts without stability`() = runBlocking {
        // Sequence keeps changing: each call returns different bytes.
        // Budget 250ms with 100ms interval → 2 sample waits → 3 total
        // captures (initial + 2 samples). Returns the final never-stable
        // capture.
        val driver = SequenceShotDriver(listOf(
            byteArrayOf(1),
            byteArrayOf(2),
            byteArrayOf(3),
            byteArrayOf(4), // extra to satisfy any off-by-one
        ))
        val out = captureStableScreenshot(driver, timeoutMs = 250)
        // Last-used array depends on exact iteration count; just assert
        // it's one of the late entries and at least 2 samples were
        // taken.
        assertTrue(driver.calls >= 3, "expected at least 3 captures, got ${driver.calls}")
        assertArrayEquals(driver.lastReturned, out)
    }

    @Test
    fun `stability detected on first poll (bytes already match)`() = runBlocking {
        // Initial and sample 2 are identical → stable immediately on
        // the first poll. Two total captures.
        val a = byteArrayOf(7, 7, 7)
        val driver = SequenceShotDriver(listOf(a, a, a))
        val out = captureStableScreenshot(driver, timeoutMs = 1000)
        assertArrayEquals(a, out)
        assertEquals(2, driver.calls)
    }
}

/**
 * WebDriver stub that returns a pre-baked sequence of byte arrays
 * from `getScreenshotAs`. Each call advances by one; the last entry
 * is returned for any call beyond the list length so a test doesn't
 * have to size the sequence exactly.
 */
private class SequenceShotDriver(private val sequence: List<ByteArray>) :
    WebDriver, TakesScreenshot {
    var calls = 0
    var lastReturned: ByteArray = ByteArray(0)

    @Suppress("UNCHECKED_CAST")
    override fun <X : Any> getScreenshotAs(target: OutputType<X>): X {
        val idx = calls.coerceAtMost(sequence.size - 1)
        calls += 1
        lastReturned = sequence[idx]
        return lastReturned as X
    }

    override fun get(url: String) = Unit
    override fun getCurrentUrl(): String = ""
    override fun getTitle(): String = ""
    override fun findElements(by: By): List<WebElement> = emptyList()
    override fun findElement(by: By): WebElement = throw NotImplementedError()
    override fun getPageSource(): String = ""
    override fun close() = Unit
    override fun quit() = Unit
    override fun getWindowHandles(): Set<String> = emptySet()
    override fun getWindowHandle(): String = ""
    override fun switchTo(): WebDriver.TargetLocator = throw NotImplementedError()
    override fun navigate(): WebDriver.Navigation = throw NotImplementedError()
    override fun manage(): WebDriver.Options = throw NotImplementedError()
}
