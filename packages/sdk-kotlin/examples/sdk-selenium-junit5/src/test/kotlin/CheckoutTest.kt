import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Smoke example for the Furan Selenium adapter.
 *
 * Skipped unless `FURAN_API_URL` is set, since the SDK requires a running
 * apps/api + a valid API token to upload snapshots. Run locally via:
 *
 *   FURAN_API_URL=http://localhost:3000 \
 *   FURAN_API_TOKEN=... \
 *   FURAN_PROJECT_ID=... \
 *   ./gradlew test
 *
 * Selenium Manager (bundled with Selenium 4.27.0) auto-resolves a matching
 * Chrome + driver, so no manual driver setup is required.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutTest {

    @Test
    fun `captures two snapshots on a static page`() {
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        val furan = Furan(driver, FuranConfig.fromEnv())
        try {
            driver.get("data:text/html,<html><body><h1>Checkout</h1><p>Step 1</p></body></html>")
            furan.snapshot("checkout-step-1")

            driver.get("data:text/html,<html><body><h1>Checkout</h1><p>Step 2</p></body></html>")
            furan.snapshot("checkout-step-2")
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
