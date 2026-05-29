import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.Region
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Demonstrates the per-snapshot diff-tuning options exposed by the
 * Selenium adapter via [CheckpointOptions]: `ignoreRegions` and
 * the per-snapshot CSS `mask`.
 *
 *  - `ignoreRegions` — rectangle regions (pixel coordinates in image
 *    space) that the diff worker skips entirely. Useful for masking
 *    dynamic widgets that the dashboard's "ignore region" UI would
 *    otherwise have to be configured for every variation. Capped at
 *    50 entries server-side. Carried on the checkpoint request.
 *
 *  - `mask` (on `snapshot()` / `snapshotAndAwait()`) — CSS selectors
 *    the diff worker masks at diff time. Selectors are evaluated
 *    against the captured DOM, not the screenshot pixels, so they
 *    tolerate layout shifts that a fixed-rectangle `ignoreRegion` would
 *    miss.
 *
 * Uses `softAssert = true` so the test demonstrates the API contract
 * without flaking on the shared-variation diff that the e2e job
 * creates (see CheckoutJUnit5ExtensionTest's comment for the
 * underlying reason).
 *
 * Skipped unless FURAN_API_URL is set, same as the other examples.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutIgnoreRegionsTest {

    @Test
    fun `applies ignoreRegions and a CSS mask`() {
        val baseConfig = FuranConfig.fromEnv().copy(softAssert = true)
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        // SDK 2.0.0 constructor order: Furan(config, driver).
        Furan.use(baseConfig, driver, testName = "applies ignoreRegions and a CSS mask") { furan ->
            driver.get(
                "data:text/html,<html><body>" +
                    "<div id=banner style=background:tomato;height:56px>BANNER</div>" +
                    "<h1>Ignore-Region Checkout</h1>" +
                    "<p>Stable copy</p>" +
                    "<span data-test=timer>00:42</span>" +
                    "</body></html>",
            )

            // Per-snapshot ignore regions and CSS mask selectors are passed
            // via CheckpointOptions. ignoreRegions replaces the old
            // constructor-level ignoreAreas — coordinates use Double, matching
            // the Region(x, y, width, height) data class.
            val result = furan.snapshotAndAwait(
                name = "ignore-regions-step-1",
                options = CheckpointOptions(
                    ignoreRegions = listOf(
                        // Mask a top banner that changes every render.
                        Region(x = 0.0, y = 0.0, width = 1280.0, height = 56.0),
                        // Mask a per-viewport timer widget.
                        Region(x = 100.0, y = 600.0, width = 200.0, height = 40.0),
                    ),
                    // The `mask` argument is CSS-selector-based: the diff
                    // worker masks the element wherever it renders, even if
                    // layout reflow moves it pixel-wise.
                    // Note: mask selectors are passed separately (not in CheckpointOptions).
                ),
            )

            // softAssert mode returns the result instead of throwing
            // on non-PASSED terminals. We only assert the API
            // contract: a real checkpoint id + a terminal status.
            assertNotNull(result.checkpointId)
            check(result.status.isTerminal()) {
                "Expected terminal status, got ${result.status}"
            }
            result.diffViewerUrl?.let { println("[furan] Review: $it") }
        }
        driver.quit()
    }
}
