package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class DomCaptureTest {
    @Test
    fun `captures DOM via JavascriptExecutor`() {
        val driver = StubDriver(domHtml = "<html><body><h1>Test</h1></body></html>")
        assertEquals("<html><body><h1>Test</h1></body></html>", captureDom(driver))
    }

    @Test
    fun `returns empty string when executeScript returns non-string`() {
        val driver = StubDriver(domHtml = "<html></html>", returnNullScript = true)
        assertEquals("", captureDom(driver))
    }

    @Test
    fun `errors when driver does not implement JavascriptExecutor`() {
        val driver = NoJsDriver()
        assertThrows(IllegalStateException::class.java) { captureDom(driver) }
    }
}

/**
 * Minimal stub of [WebDriver] + [JavascriptExecutor] for unit tests. Returns
 * the configured DOM string when the test script is invoked.
 */
private class StubDriver(
    val domHtml: String,
    val returnNullScript: Boolean = false,
) : WebDriver, JavascriptExecutor {
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
    override fun executeScript(script: String, vararg args: Any?): Any? = when {
        returnNullScript -> null
        script.contains("outerHTML") -> domHtml
        else -> null
    }
    override fun executeAsyncScript(script: String, vararg args: Any?): Any? = null
}

/** WebDriver that intentionally does NOT implement [JavascriptExecutor]. */
private class NoJsDriver : WebDriver {
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
