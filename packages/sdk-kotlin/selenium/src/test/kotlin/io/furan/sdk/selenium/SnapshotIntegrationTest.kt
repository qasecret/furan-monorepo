package io.furan.sdk.selenium

import io.furan.sdk.FuranConfig
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Opt-in end-to-end test: requires Chrome installed locally, a running
 * `apps/api`, and valid `FURAN_API_URL`, `FURAN_API_TOKEN`, `FURAN_PROJECT_ID`
 * env vars. Enable by exporting `FURAN_SDK_INTEGRATION=1`.
 *
 * CI does NOT run this by default. The maintainer invokes it before tagging.
 *
 * ADR-038 SDK 2.0.0 lifecycle: open → snapshot → close.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_SDK_INTEGRATION", matches = "1")
class SnapshotIntegrationTest {

    @Test
    fun `open-snapshot-close routes through FuranClient`() {
        val opts = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(opts)
        val furan = Furan(FuranConfig.fromEnv(), driver)
        try {
            furan.open("integration-test-example")
            driver.get("https://example.com")
            furan.snapshot("integration-test-example")
            furan.close()
        } catch (e: Throwable) {
            furan.abort()
            throw e
        } finally {
            driver.quit()
        }
    }
}
