import io.furan.sdk.FuranAssertionException
import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Demonstrates the typed-result API: `snapshotAndAwait()` blocks until
 * the diff worker produces a terminal status, returns a typed
 * [io.furan.sdk.dto.SnapshotResult], and throws
 * [FuranAssertionException] on UNRESOLVED / FAILED / ABORTED unless
 * the caller opts into soft-assert via `FURAN_SOFT_ASSERT=true`.
 *
 * Compare to CheckoutTest (fire-and-forget `snapshot()`) — that path
 * still exists and is preferred for fast capture-only workflows where
 * the test asserts via the dashboard separately. This path is
 * preferred for CI tests that need to fail loudly on visual
 * regressions in the same job.
 *
 * Skipped unless FURAN_API_URL is set, same as the other examples.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutAwaitTest {

    @Test
    fun `awaits the diff result and asserts PASSED`() {
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        val furan = Furan(driver, FuranConfig.fromEnv())
        try {
            driver.get(
                "data:text/html,<html><body><h1>Await Checkout</h1>" +
                    "<p>Stable copy</p></body></html>",
            )

            // Blocks until the diff worker reports a terminal status.
            // Throws FuranAssertionException if non-PASSED (unless
            // FURAN_SOFT_ASSERT=true in env). Returns SnapshotResult
            // on success — useful for logging the run id + diff URL.
            val result = furan.snapshotAndAwait("checkout-await-step-1")

            // First baseline for this variation auto-approves to PASSED;
            // every subsequent run on the same page bytes-identical
            // also stays PASSED. If the test author changes the copy and
            // re-runs, this assertion catches the regression.
            assertEquals(RunStatus.PASSED, result.status)

            // CI log breadcrumb: print the dashboard link so a reviewer
            // can hop straight to the diff viewer for failures.
            result.diffViewerUrl?.let { println("[furan] Review: $it") }
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
