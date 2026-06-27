package io.furan.sdk.playwright

import com.microsoft.playwright.Page
import io.furan.sdk.FuranConfig
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.mockito.kotlin.mock
import org.mockito.kotlin.whenever

/**
 * Unit tests for the Playwright [Loupe] Applitools-compat facade.
 *
 * All assertions are pure (no network calls):
 *   - `saveNewTests` default is true (Eyes-parity)
 *   - The facade exposes the expected lifecycle methods
 *   - check-before-open propagates the engine's guard (delegation confirmed)
 */
class LoupeDelegationTest {

    private fun testConfig() = FuranConfig(
        apiUrl = "http://127.0.0.1:1",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
    )

    private fun mockPage(): Page {
        // RETURNS_DEEP_STUBS so page.context().browser()... doesn't NPE during driver init.
        val page = mock<Page>(defaultAnswer = Mockito.RETURNS_DEEP_STUBS)
        whenever(page.viewportSize()).thenReturn(null)
        return page
    }

    @Test
    fun `Loupe defaults saveNewTests true on its config`() {
        val loupe = Loupe(testConfig(), mockPage())
        assertTrue(loupe.config.saveNewTests)
    }

    @Test
    fun `Loupe exposes open check close abort`() {
        val names = Loupe::class.java.declaredMethods.map { it.name }.toSet()
        assertTrue(names.containsAll(setOf("open", "check", "close", "abort")))
    }

    @Test
    fun `Loupe check delegates to capture and throws before open (no network)`() {
        val loupe = Loupe(testConfig(), mockPage())
        val ex = assertThrows(IllegalStateException::class.java) {
            loupe.check("step-without-open")
        }
        assertTrue(ex.message?.contains("open") == true)
    }
}
