import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Companion to CheckoutTest used by the local QA pass to seed a CANDIDATE
 * run whose screenshot bytes diverge from the baseline. The DOM differs
 * (extra <p>) so the L1 pixel diff is non-zero and the L2 DOM diff has
 * regions to highlight. Skipped unless FURAN_API_URL is set, same as
 * CheckoutTest.
 *
 * Intended to be invoked with a second FURAN_BUILD_ID and a feature-branch
 * FURAN_BRANCH so the variation resolver pairs it against the main-branch
 * baseline created by CheckoutTest.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutCandidateTest {

    @Test
    fun `captures a different snapshot for the candidate branch`() {
        val options = ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
        }
        val driver = ChromeDriver(options)
        // SDK 2.0.0 constructor order: Furan(config, driver).
        Furan.use(FuranConfig.fromEnv(), driver, testName = "captures a different snapshot for the candidate branch") { furan ->
            // No quotes inside the data: URL — Chrome treats unencoded
            // single-quotes as part of the URL value and the page ends up
            // blank. Use a quote-free style attribute (color word) and
            // double-quote-free HTML so the document actually renders.
            driver.get(
                "data:text/html,<html><body bgcolor=peachpuff>" +
                    "<h1>Checkout</h1>" +
                    "<p>Step 1 (revised copy)</p>" +
                    "<button>Continue</button>" +
                    "</body></html>",
            )
            furan.snapshot("checkout-step-1")
        }
        driver.quit()
    }
}
