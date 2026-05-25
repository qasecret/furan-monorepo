import io.furan.sdk.FuranConfig
import io.furan.sdk.junit5.FuranTest
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Demonstrates the @FuranTest JUnit5 extension: the test class no
 * longer has to call FuranConfig.fromEnv() in @BeforeEach (or in
 * every method). The extension loads + caches the config once per
 * test class and parameter-resolves it into @Test methods.
 *
 * Compare to CheckoutTest (the long-form ergonomics that #128
 * introduced):
 *
 *   val driver = ChromeDriver(opts)
 *   val furan = Furan(driver, FuranConfig.fromEnv())   <-- gone
 *   try { ... } finally { furan.close(); driver.quit() }
 *
 * With @FuranTest the FuranConfig is injected; the user still
 * supplies the driver (deliberately — Furan adapters are
 * driver-agnostic and #5's scope didn't include browser
 * lifecycle management).
 *
 * Skipped unless FURAN_API_URL is set, same as the other examples.
 */
@FuranTest
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutJUnit5ExtensionTest {

    @Test
    fun `injected FuranConfig + snapshot round-trip`(config: FuranConfig) {
        // Asserts the JUnit5 extension wiring — config injected,
        // snapshot upload + diff worker complete a round-trip and
        // return a typed SnapshotResult with a real runId.
        //
        // Soft-assert mode (FURAN_SOFT_ASSERT=true): all 4 example
        // test classes share one project + one variation
        // ("snapshot-run") in CI, so whichever runs first owns the
        // baseline and the rest land at UNRESOLVED. We want the test
        // to demonstrate the API contract without flaking on shared-
        // state diffs — the underlying snapshotAndAwait path is
        // exhaustively covered by core's unit tests + by
        // CheckoutAwaitTest's first-baseline path.
        assertNotNull(config)
        val softConfig = config.copy(softAssert = true)
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        val furan = Furan(driver, softConfig)
        try {
            driver.get(
                "data:text/html,<html><body><h1>JUnit5 Extension</h1>" +
                    "<p>Stable</p></body></html>",
            )
            val result = furan.snapshotAndAwait("junit5-ext-step-1")
            // The snapshot result must always have a real run id +
            // terminal status, regardless of pass/fail (softAssert
            // means failure terminals come back as a result instead
            // of throwing).
            assertNotNull(result.runId)
            assertTrue(result.status.isTerminal(), "Expected terminal status, got ${result.status}")
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
