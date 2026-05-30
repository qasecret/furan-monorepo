package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class FixedElementHiderTest {

    @Test
    fun `inject builds a single style element with all selectors`() {
        val driver = RecordingDriver()
        injectFixedElementHider(driver, listOf("header", "footer"))
        // First script call should create the style element.
        val script = driver.scripts.single()
        assertTrue(script.contains("__furan_fixed_hide"), "style id present: $script")
        assertTrue(script.contains("header,footer{display:none !important}"),
            "selectors joined as a single rule: $script")
    }

    @Test
    fun `inject is a no-op when selectors list is empty`() {
        val driver = RecordingDriver()
        injectFixedElementHider(driver, emptyList())
        assertEquals(0, driver.scripts.size)
    }

    @Test
    fun `inject silently skips non-JS drivers`() {
        // Must not throw on a driver that does not implement
        // JavascriptExecutor. Same pattern as runLazyLoadScroll.
        injectFixedElementHider(NoJsDriverFH(), listOf("header"))
    }

    @Test
    fun `remove deletes the style element`() {
        val driver = RecordingDriver()
        removeFixedElementHider(driver)
        val script = driver.scripts.single()
        assertTrue(script.contains("__furan_fixed_hide"))
        assertTrue(script.contains("remove"), "must call .remove(): $script")
    }

    @Test
    fun `remove silently skips non-JS drivers`() {
        removeFixedElementHider(NoJsDriverFH())
    }

    @Test
    fun `selectors are CSS-escaped to prevent injection`() {
        val driver = RecordingDriver()
        // A malicious selector containing a CSS string-break attempt.
        injectFixedElementHider(driver, listOf("div[id=\"x\\\"}*{color:red}\"]"))
        val script = driver.scripts.single()
        // The selector must be passed through arguments, not interpolated
        // into the script source, so a quote in the selector cannot break
        // out of the JS string.
        assertTrue(
            !script.contains("color:red"),
            "selector must not appear as raw CSS in the injected script source",
        )
    }
}

private class RecordingDriver : WebDriver, JavascriptExecutor {
    val scripts = mutableListOf<String>()
    val scriptArgs = mutableListOf<Array<out Any?>>()

    override fun executeScript(script: String, vararg args: Any?): Any? {
        scripts.add(script)
        scriptArgs.add(args)
        return null
    }
    override fun executeAsyncScript(script: String, vararg args: Any?): Any? = null

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

private class NoJsDriverFH : WebDriver {
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
