import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.IgnoreArea
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Demonstrates the per-test diff-tuning options exposed by the
 * Selenium adapter: `ignoreAreas`, `diffTolerance`, and the
 * per-snapshot CSS `mask`.
 *
 *  - `ignoreAreas` — rectangle regions (pixel coordinates in image
 *    space) that the diff worker skips entirely. Useful for masking
 *    dynamic widgets that the dashboard's "ignore region" UI would
 *    otherwise have to be configured for every variation. Capped at
 *    50 entries server-side. Carried on `CreateRunRequest`, so the
 *    first diff job picks them up — no `setIgnoreAreas` round-trip.
 *
 *  - `diffTolerance` — per-test override (0.0–1.0) that replaces the
 *    project default for every run created by this Furan instance.
 *    `0.005` = tolerate diffs up to 0.5% of pixels changed.
 *
 *  - `mask` (on `snapshot()` / `snapshotAndAwait()`) — CSS selectors
 *    the diff worker masks at diff time. Selectors are evaluated
 *    against the captured DOM, not the screenshot pixels, so they
 *    tolerate layout shifts that a fixed-rectangle `ignoreArea` would
 *    miss.
 *
 * Both modes compose: ignoreAreas mask known-fixed rectangles
 * (banner ad slots, version strings), `mask` selectors mask
 * known-DOM-stable elements wherever they end up rendering (a
 * "session timer" badge, a chat bubble).
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
    fun `applies ignoreAreas, diffTolerance, and a CSS mask`() {
        val baseConfig = FuranConfig.fromEnv().copy(softAssert = true)
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)

        // Per-test ignore regions + diff tolerance are passed to the
        // Furan constructor (not the snapshot call). They apply to
        // every run created by this Furan instance — the dashboard
        // can still amend them later via the tRPC mutations.
        val furan = Furan(
            driver = driver,
            config = baseConfig,
            diffTolerance = 0.005,
            ignoreAreas = listOf(
                // Mask a top banner that changes every render.
                IgnoreArea(x = 0, y = 0, width = 1280, height = 56),
                // Mask a per-viewport timer widget; null viewport
                // applies the area to every viewport.
                IgnoreArea(x = 100, y = 600, width = 200, height = 40),
            ),
        )
        try {
            driver.get(
                "data:text/html,<html><body>" +
                    "<div id=banner style=background:tomato;height:56px>BANNER</div>" +
                    "<h1>Ignore-Region Checkout</h1>" +
                    "<p>Stable copy</p>" +
                    "<span data-test=timer>00:42</span>" +
                    "</body></html>",
            )

            // The `mask` argument here is CSS-selector-based: the diff
            // worker masks the element wherever it renders, even if
            // layout reflow moves it pixel-wise.
            val result = furan.snapshotAndAwait(
                name = "ignore-regions-step-1",
                mask = listOf("[data-test=timer]"),
            )

            // softAssert mode returns the result instead of throwing
            // on non-PASSED terminals. We only assert the API
            // contract: a real run id + a terminal status.
            assertNotNull(result.runId)
            check(result.status.isTerminal()) {
                "Expected terminal status, got ${result.status}"
            }
            result.diffViewerUrl?.let { println("[furan] Review: $it") }
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
