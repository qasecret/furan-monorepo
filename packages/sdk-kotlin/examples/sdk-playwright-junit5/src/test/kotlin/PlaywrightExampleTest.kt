import com.microsoft.playwright.Playwright
import io.furan.sdk.FuranConfig
import io.furan.sdk.playwright.FuranPlaywright
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable

/**
 * Smoke example for the Furan Playwright adapter — the
 * `snapshotAndAwait` path that blocks until the diff worker produces a
 * terminal status. Mirrors [CheckoutAwaitTest] in the Selenium example.
 *
 * Skipped unless `FURAN_API_URL` is set, since the SDK requires a
 * running apps/api + a valid API token to upload snapshots. Run locally via:
 *
 *   FURAN_API_URL=http://localhost:3000 \
 *   FURAN_API_TOKEN=... \
 *   FURAN_PROJECT_ID=... \
 *   ./gradlew test
 *
 * Playwright downloads its own browser binaries on first run — no manual
 * driver setup required. `browserName` is reported as `playwright-chromium`
 * so the run keeps a separate baseline from Selenium / firefox / webkit.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class PlaywrightExampleTest {
    @Test
    fun `playwright snapshot round-trip`() {
        Playwright.create().use { pw ->
            val browser = pw.chromium().launch()
            val page = browser.newPage()
            page.navigate("data:text/html,<h1>Furan + Playwright</h1>")
            val result = FuranPlaywright.use(FuranConfig.fromEnv(), page, "playwright smoke") { furan ->
                furan.snapshotAndAwait("home")
            }
            assertTrue(result.checkpointId.isNotBlank())
            browser.close()
        }
    }
}
