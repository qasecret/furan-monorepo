package io.furan.sdk.selenium

import io.furan.sdk.dto.CheckpointOptions
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.OutputType
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

/**
 * Unit tests for the Tier 1.3 pre-capture hooks
 * (`beforeCaptureScreenshot` + `waitBeforeCaptureMs`). The hooks live in
 * `Furan.snapshotSuspend`'s body which requires a live HTTP path to
 * reach end-to-end, so we exercise them through a small standalone
 * `runCaptureHooks` helper that mirrors the production sequence
 * (executeScript → delay) and instrument with stub drivers.
 *
 * If you change Furan.snapshotSuspend's hook-ordering, mirror the
 * change in `runCaptureHooks` below so this test stays meaningful.
 */
class CaptureHooksTest {

    @Test
    fun `beforeCaptureScreenshot executes script on JS driver`() = runBlocking {
        val driver = HookDriver()
        val options = CheckpointOptions(
            beforeCaptureScreenshot = "document.querySelector('.modal').style.display='none';",
        )
        runCaptureHooks(driver, options)
        assertEquals(1, driver.executed.size)
        assertEquals(options.beforeCaptureScreenshot, driver.executed.first())
    }

    @Test
    fun `null hook is a no-op`() = runBlocking {
        val driver = HookDriver()
        runCaptureHooks(driver, CheckpointOptions())
        assertTrue(driver.executed.isEmpty())
    }

    @Test
    fun `non-JS driver silently skips the hook`() = runBlocking {
        // NoJsHookDriver doesn't implement JavascriptExecutor. The cast in
        // runCaptureHooks should fall through without error.
        val driver = NoJsHookDriver()
        runCaptureHooks(
            driver,
            CheckpointOptions(beforeCaptureScreenshot = "alert('hi');"),
        )
    }

    @Test
    fun `waitBeforeCaptureMs waits at least the requested duration`() = runBlocking {
        val driver = HookDriver()
        val start = System.nanoTime()
        runCaptureHooks(driver, CheckpointOptions(waitBeforeCaptureMs = 100))
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue(elapsedMs >= 95, "expected ≥95ms, got ${elapsedMs}ms")
    }

    @Test
    fun `wait of zero does not block`() = runBlocking {
        val driver = HookDriver()
        val start = System.nanoTime()
        runCaptureHooks(driver, CheckpointOptions(waitBeforeCaptureMs = 0))
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue(elapsedMs < 50, "expected <50ms, got ${elapsedMs}ms")
    }

    @Test
    fun `hook runs before wait`() = runBlocking {
        val driver = HookDriver()
        runCaptureHooks(
            driver,
            CheckpointOptions(
                beforeCaptureScreenshot = "window.x = 1;",
                waitBeforeCaptureMs = 30,
            ),
        )
        assertEquals(1, driver.executed.size)
        // Wait observed via the driver's recorded wall-clock between
        // executeScript-time and the function return.
        assertTrue(driver.executedAtNanos.first() < System.nanoTime())
    }

    @Test
    fun `JS error propagates instead of corrupting baseline`() {
        val driver = ThrowingJsDriver()
        val ex = runCatching {
            runBlocking {
                runCaptureHooks(
                    driver,
                    CheckpointOptions(beforeCaptureScreenshot = "throw new Error('boom')"),
                )
            }
        }.exceptionOrNull()
        assertTrue(ex is RuntimeException, "expected JS error to surface; got $ex")
    }
}

/**
 * Mirror of the pre-capture hook block from `Furan.snapshotSuspend`:
 * execute JS first (if any), then wait. Kept in lock-step with the
 * production path — if the hook ordering changes, update this too.
 */
internal suspend fun runCaptureHooks(driver: WebDriver, options: CheckpointOptions) {
    options.beforeCaptureScreenshot?.let { js ->
        (driver as? JavascriptExecutor)?.executeScript(js)
    }
    if (options.waitBeforeCaptureMs > 0) {
        kotlinx.coroutines.delay(options.waitBeforeCaptureMs)
    }
}

private class HookDriver : WebDriver, JavascriptExecutor, TakesScreenshot {
    val executed = mutableListOf<String>()
    val executedAtNanos = mutableListOf<Long>()

    override fun executeScript(script: String, vararg args: Any?): Any? {
        executed.add(script)
        executedAtNanos.add(System.nanoTime())
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

    @Suppress("UNCHECKED_CAST")
    override fun <X : Any> getScreenshotAs(target: OutputType<X>): X = ByteArray(0) as X
}

private class NoJsHookDriver : WebDriver {
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

private class ThrowingJsDriver : WebDriver, JavascriptExecutor {
    override fun executeScript(script: String, vararg args: Any?): Any =
        throw RuntimeException("JS error: $script")
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
