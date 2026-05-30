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
    fun `inject passes joined CSS rule as a single argument`() {
        val driver = RecordingDriver()
        injectFixedElementHider(driver, listOf("header", "footer"))
        // One script call.
        val script = driver.scripts.single()
        val args = driver.scriptArgs.single()
        // The script SOURCE must reference the style id (for the bookkeeping
        // tag) and must read from arguments[0] — selectors must NOT appear
        // interpolated into the source.
        assertTrue(script.contains("__furan_fixed_hide"), "style id present: $script")
        assertTrue(script.contains("arguments[0]"), "must read CSS from arguments[0]: $script")
        assertEquals(false, script.contains("header"),
            "selectors must not be interpolated into script source: $script")
        // The CSS rule is the single argument.
        assertEquals(1, args.size)
        assertEquals("header,footer{display:none !important}", args[0])
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
    fun `hostile selectors pass through the argument channel, not the script source`() {
        val driver = RecordingDriver()
        // A selector containing a single-quote, brace, and CSS rule-break
        // attempt. With argument-passing, it lands in args[0] unmodified
        // and cannot escape into the script source.
        val hostile = "'); alert('xss'); //"
        injectFixedElementHider(driver, listOf(hostile))
        val script = driver.scripts.single()
        val args = driver.scriptArgs.single()
        // The hostile substring must NOT appear in the script source.
        assertEquals(false, script.contains("alert"),
            "hostile selector must not leak into script source: $script")
        assertEquals(false, script.contains(hostile),
            "hostile selector must not appear in script source: $script")
        // It IS present in arguments[0] — that's fine because it never
        // gets evaluated as JS, only assigned to textContent.
        assertTrue((args[0] as String).contains(hostile),
            "hostile selector is preserved in arguments[0] (assigned to textContent, never eval'd)")
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
