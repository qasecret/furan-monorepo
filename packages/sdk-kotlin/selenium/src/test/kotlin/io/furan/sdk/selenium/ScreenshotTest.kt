package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class ScreenshotTest {
    @Test
    fun `captures PNG bytes via TakesScreenshot`() {
        val expected = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val driver = ShotDriver(expected)
        assertArrayEquals(expected, captureScreenshot(driver))
    }

    @Test
    fun `errors when driver does not implement TakesScreenshot`() {
        val driver = NoShotDriver()
        assertThrows(IllegalStateException::class.java) { captureScreenshot(driver) }
    }
}

/** Stub WebDriver that also implements [TakesScreenshot] and returns fixed bytes. */
private class ShotDriver(val pngBytes: ByteArray) : WebDriver, TakesScreenshot {
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

    @Suppress("UNCHECKED_CAST")
    override fun <X : Any> getScreenshotAs(target: OutputType<X>): X {
        // The OutputType passed in tests is BYTES; cast accordingly.
        return pngBytes as X
    }
}

private class NoShotDriver : WebDriver {
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
