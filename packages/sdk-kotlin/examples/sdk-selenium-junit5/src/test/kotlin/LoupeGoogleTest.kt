import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Loupe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Applitools-shaped test (open → check → close) using the Furan Loupe compat
 * facade. saveNewTests defaults true for Loupe, so the first run seeds the
 * baseline and passes; later runs diff against it. With FURAN_FAIL_ON_DIFF=AfterEach
 * a diff makes close() throw. Skipped unless FURAN_API_URL is set.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class LoupeGoogleTest {
    @Test
    fun `loupe captures the google homepage`() {
        val driver = ChromeDriver(ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900", "--lang=en-US")
        })
        val loupe = Loupe(FuranConfig.fromEnv(), driver)
        try {
            loupe.open("Furan Demo", "Google Home")
            driver.get("https://www.google.com/")
            loupe.check("home")
            loupe.close()
        } catch (e: Throwable) {
            loupe.abort()
            throw e
        } finally {
            driver.quit()
        }
    }
}
