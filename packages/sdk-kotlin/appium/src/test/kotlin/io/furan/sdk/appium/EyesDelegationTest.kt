package io.furan.sdk.appium

import io.appium.java_client.AppiumDriver
import io.furan.sdk.FuranConfig
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.kotlin.mock
import org.mockito.kotlin.whenever
import org.openqa.selenium.Capabilities

/**
 * Unit tests for the Appium [Eyes] Applitools-compat facade.
 *
 * All assertions are pure (no network / device calls):
 *   - `saveNewTests` default is true (Eyes-parity)
 *   - The facade exposes the expected lifecycle methods
 *   - check-before-open propagates the engine's guard (delegation confirmed)
 */
class EyesDelegationTest {

    private fun testConfig() = FuranConfig(
        apiUrl = "http://127.0.0.1:1",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
    )

    private fun mockDriver(): AppiumDriver {
        val caps = mock<Capabilities>()
        whenever(caps.getCapability("platformName")).thenReturn("Android")
        whenever(caps.getCapability("deviceName")).thenReturn("Pixel_7")
        val driver = mock<AppiumDriver>()
        whenever(driver.capabilities).thenReturn(caps)
        return driver
    }

    @Test
    fun `Eyes defaults saveNewTests true on its config`() {
        val eyes = Eyes(testConfig(), mockDriver())
        assertTrue(eyes.config.saveNewTests)
    }

    @Test
    fun `Eyes exposes open check close abort`() {
        val names = Eyes::class.java.declaredMethods.map { it.name }.toSet()
        assertTrue(names.containsAll(setOf("open", "check", "close", "abort")))
    }

    @Test
    fun `Eyes check delegates to capture and throws before open (no network)`() {
        val eyes = Eyes(testConfig(), mockDriver())
        val ex = assertThrows(IllegalStateException::class.java) {
            eyes.check("step-without-open")
        }
        assertTrue(ex.message?.contains("open") == true)
    }
}
