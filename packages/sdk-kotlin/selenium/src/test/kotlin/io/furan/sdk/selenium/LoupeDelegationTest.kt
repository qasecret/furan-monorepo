package io.furan.sdk.selenium

import io.furan.sdk.FuranConfig
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Unit tests for the [Loupe] Applitools-compat facade.
 *
 * All assertions are pure (no network / browser calls):
 *   - `saveNewTests` default is true (Eyes-parity)
 *   - The facade exposes the expected lifecycle methods
 *   - snapshot-before-open propagates the engine's guard (delegation confirmed)
 */
class LoupeDelegationTest {

    @Test
    fun `Loupe defaults saveNewTests true on its config`() {
        val cfg = FuranConfig(
            apiUrl = "http://127.0.0.1:1",
            apiToken = "furan_pat_test_abcdefghijklmnopqrst",
            projectId = "00000000-0000-0000-0000-000000000000",
            telemetryEnabled = false,
        )
        val loupe = Loupe(cfg, LoupeNoOpDriver())
        assertTrue(loupe.config.saveNewTests)
    }

    @Test
    fun `Loupe exposes open check close abort`() {
        val names = Loupe::class.java.declaredMethods.map { it.name }.toSet()
        assertTrue(names.containsAll(setOf("open", "check", "close", "abort")))
    }

    @Test
    fun `Loupe check delegates to capture and throws before open (no network)`() {
        val cfg = FuranConfig(
            apiUrl = "http://127.0.0.1:1",
            apiToken = "furan_pat_test_abcdefghijklmnopqrst",
            projectId = "00000000-0000-0000-0000-000000000000",
            telemetryEnabled = false,
        )
        val loupe = Loupe(cfg, LoupeNoOpDriver())
        // FuranCapture.snapshot() throws IllegalStateException before any network call
        // when no run is open — confirms delegation is wired.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException::class.java) {
            loupe.check("step-without-open")
        }
        assertTrue(ex.message?.contains("open") == true)
    }
}

// ---------------------------------------------------------------------------
// Minimal WebDriver stub for Loupe unit tests — no browser, no server needed.
// ---------------------------------------------------------------------------
private class LoupeNoOpDriver : org.openqa.selenium.WebDriver {
    override fun get(url: String) = Unit
    override fun getCurrentUrl(): String = ""
    override fun getTitle(): String = ""
    override fun findElements(by: org.openqa.selenium.By): List<org.openqa.selenium.WebElement> = emptyList()
    override fun findElement(by: org.openqa.selenium.By): org.openqa.selenium.WebElement = throw NotImplementedError()
    override fun getPageSource(): String = ""
    override fun close() = Unit
    override fun quit() = Unit
    override fun getWindowHandles(): Set<String> = emptySet()
    override fun getWindowHandle(): String = ""
    override fun switchTo(): org.openqa.selenium.WebDriver.TargetLocator = throw NotImplementedError()
    override fun navigate(): org.openqa.selenium.WebDriver.Navigation = throw NotImplementedError()
    override fun manage(): org.openqa.selenium.WebDriver.Options = throw NotImplementedError()
}
