import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.junit5.FuranTest
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
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
    fun `captures and awaits with the injected config`(config: FuranConfig) {
        assertNotNull(config)
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        val furan = Furan(driver, config)
        try {
            driver.get(
                "data:text/html,<html><body><h1>JUnit5 Extension</h1>" +
                    "<p>Stable</p></body></html>",
            )
            val result = furan.snapshotAndAwait("junit5-ext-step-1")
            // First-baseline auto-approves; subsequent runs that match
            // bytes-identical stay PASSED.
            assertEquals(RunStatus.PASSED, result.status)
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
