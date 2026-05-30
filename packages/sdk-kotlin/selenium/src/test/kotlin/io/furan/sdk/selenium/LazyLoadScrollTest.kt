package io.furan.sdk.selenium

import io.furan.sdk.dto.LazyLoadOptions
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

/**
 * Tier 2.1 — exercises the scroll-loop semantics via a stub driver that
 * records every executeScript call. We don't need a real browser to
 * verify the algorithm: stop conditions (scrollHeight reached,
 * maxAmountToScroll reached), step size, and restore-to-top.
 */
class LazyLoadScrollTest {

    @Test
    fun `scrolls in fixed-step increments until scrollHeight is reached`() = runBlocking {
        // scrollHeight = 1000, scrollLength = 300, maxAmount = 15000.
        // Expected scrollTo args: 300, 600, 900, 1200, then 0 (restore).
        val driver = ScrollDriver(scrollHeight = 1000)
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        // Strip away the scrollHeight reads — only the scrollTo args matter.
        val scrollToArgs = driver.scrolledTo
        assertEquals(listOf(300, 600, 900, 1200, 0), scrollToArgs)
    }

    @Test
    fun `stops at maxAmountToScroll`() = runBlocking {
        // scrollHeight = 100000 (effectively infinite), max = 1000,
        // step = 300. Expected scrollTo args: 300, 600, 900, 1000, then
        // 0 (restore). The last step coerces to 1000 (the cap) instead
        // of 1200.
        val driver = ScrollDriver(scrollHeight = 100_000)
        runLazyLoadScroll(
            driver,
            LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0, maxAmountToScroll = 1000),
        )
        assertEquals(listOf(300, 600, 900, 1000, 0), driver.scrolledTo)
    }

    @Test
    fun `short page bails after one step`() = runBlocking {
        // scrollHeight = 50, step = 300. First scrollTo arg is 300
        // (coerce above scrollHeight), loop exits next iteration when
        // scrolled (300) >= scrollHeight (50). Then restore to 0.
        val driver = ScrollDriver(scrollHeight = 50)
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        assertEquals(listOf(300, 0), driver.scrolledTo)
    }

    @Test
    fun `non-JS driver silently no-ops`() = runBlocking {
        val driver = NoJsScrollDriver()
        // No assertion on exceptions — just must complete without throwing.
        runLazyLoadScroll(driver, LazyLoadOptions(waitingTimeMs = 0))
    }

    @Test
    fun `restores scrollY to 0 even when scrollHeight ends the loop early`() = runBlocking {
        val driver = ScrollDriver(scrollHeight = 600)
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        // Last entry MUST be 0 — the restore-to-top step.
        assertTrue(driver.scrolledTo.isNotEmpty())
        assertEquals(0, driver.scrolledTo.last())
    }

    @Test
    fun `dynamic scrollHeight that grows during scroll keeps stepping until max`() = runBlocking {
        // Simulate infinite-scroll feed: every read of scrollHeight is
        // 1.5x the current scroll position, so the bound runs away. Only
        // maxAmountToScroll terminates the loop.
        val driver = GrowingScrollDriver(growthFactor = 1.5)
        runLazyLoadScroll(
            driver,
            LazyLoadOptions(scrollLength = 200, waitingTimeMs = 0, maxAmountToScroll = 800),
        )
        // Expected scrollTo args under max=800: 200, 400, 600, 800, then 0.
        assertEquals(listOf(200, 400, 600, 800, 0), driver.scrolledTo)
    }
}

private class ScrollDriver(private val scrollHeight: Int) : WebDriver, JavascriptExecutor {
    val scrolledTo = mutableListOf<Int>()

    override fun executeScript(script: String, vararg args: Any?): Any? {
        return if (script.contains("scrollHeight")) {
            scrollHeight
        } else if (script.contains("scrollTo")) {
            // window.scrollTo(0, arguments[0]) — record the y coord.
            // The restore call is `window.scrollTo(0, 0)` without args,
            // so detect that separately.
            val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
            scrolledTo.add(y)
            null
        } else null
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

/** Reports scrollHeight that grows with the cumulative scroll position. */
private class GrowingScrollDriver(private val growthFactor: Double) :
    WebDriver, JavascriptExecutor {
    val scrolledTo = mutableListOf<Int>()
    private var currentScroll = 0

    override fun executeScript(script: String, vararg args: Any?): Any? {
        return when {
            script.contains("scrollHeight") -> ((currentScroll + 100) * growthFactor).toInt()
            script.contains("scrollTo") -> {
                val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                scrolledTo.add(y)
                currentScroll = y
                null
            }
            else -> null
        }
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

private class NoJsScrollDriver : WebDriver {
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
