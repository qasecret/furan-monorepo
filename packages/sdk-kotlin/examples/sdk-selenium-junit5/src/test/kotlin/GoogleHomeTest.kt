import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * End-to-end smoke against a live external site (google.com), driving the
 * Furan Selenium adapter against a locally running Furan stack (apps/api on
 * :3000 + diff-worker).
 *
 * Captures the Google homepage as a single checkpoint and uploads it via the
 * fire-and-forget `snapshot()` path, so the FIRST run seeds a baseline-pending
 * run rather than asserting (Furan's first baseline is approved manually by
 * design). Approve the baseline in the dashboard, then re-run this test to get
 * a PASS (or a real diff if the page changed).
 *
 * Skipped unless `FURAN_API_URL` is set (fed from local.properties). Selenium
 * Manager (bundled with Selenium 4) auto-resolves the matching Chrome driver.
 *
 * Run with FURAN_FAIL_ON_DIFF=AfterEach (env or local.properties) to make a visual diff fail the build via close().
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class GoogleHomeTest {

    @Test
    fun `captures the google homepage`() {
        val options = ChromeOptions().apply {
            addArguments(
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--window-size=1280,900",
                "--hide-scrollbars",
                "--lang=en-US",
            )
        }
        val driver = ChromeDriver(options)
        Furan.use(FuranConfig.fromEnv(), driver, testName = "google homepage") { furan ->
            driver.get("https://www.google.com/")
            furan.snapshot("google-homepage")
        }
        driver.quit()
    }
}
