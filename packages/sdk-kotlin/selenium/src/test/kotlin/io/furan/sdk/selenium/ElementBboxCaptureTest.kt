package io.furan.sdk.selenium

import io.furan.sdk.ELEMENT_BBOX_SCRIPT
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

/**
 * Drives Furan.captureElementBboxes() directly with stub drivers — pure
 * unit tests, no real browser. The headless-Chrome end-to-end coverage lives
 * in SnapshotIntegrationTest (opt-in via FURAN_SDK_INTEGRATION=1).
 */
class ElementBboxCaptureTest {

    @Test
    fun `returns the raw JSON string when driver returns one`() {
        val payload = """{"v":1,"elements":{},"capturedAt":1}"""
        val driver = ElmStubDriver(scriptResult = payload)
        val result = Furan.captureElementBboxes(driver)
        assertEquals(payload, result)
    }

    @Test
    fun `returns null when driver is not a JavascriptExecutor`() {
        val driver = NoJsElmDriver()
        val result = Furan.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when executeScript returns a non-String`() {
        val driver = ElmStubDriver(scriptResult = 42)
        val result = Furan.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when executeScript throws`() {
        val driver = ElmStubDriver(throwOnScript = true)
        val result = Furan.captureElementBboxes(driver)
        assertNull(result)
    }

    @Test
    fun `returns null when payload exceeds 1 MB ceiling`() {
        val huge = "x".repeat(1_000_001)
        val driver = ElmStubDriver(scriptResult = huge)
        val result = Furan.captureElementBboxes(driver)
        assertNull(result)
    }
}

/** Minimal stub of WebDriver + JavascriptExecutor for unit tests. */
private class ElmStubDriver(
    val scriptResult: Any? = null,
    val throwOnScript: Boolean = false,
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
    override fun executeScript(script: String, vararg args: Any?): Any? {
        if (throwOnScript) throw RuntimeException("driver disconnected")
        if (script == ELEMENT_BBOX_SCRIPT) return scriptResult
        return null
    }
    override fun executeAsyncScript(script: String, vararg args: Any?): Any? = null
}

/** WebDriver that intentionally does NOT implement JavascriptExecutor. */
private class NoJsElmDriver : WebDriver {
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
