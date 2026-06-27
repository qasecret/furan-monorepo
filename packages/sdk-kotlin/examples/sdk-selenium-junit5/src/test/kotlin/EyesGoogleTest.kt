import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Eyes
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Applitools-shaped test (open → check → close) using the Furan Eyes compat
 * facade. saveNewTests defaults true for Eyes, so the first run seeds the
 * baseline and passes; later runs diff against it. With FURAN_FAIL_ON_DIFF=AfterEach
 * a diff makes close() throw. Skipped unless FURAN_API_URL is set.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class EyesGoogleTest {
    @Test
    fun `eyes captures the google homepage`() {
        val driver = ChromeDriver(ChromeOptions().apply {
            addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900", "--lang=en-US")
        })
        val eyes = Eyes(FuranConfig.fromEnv(), driver)
        try {
            eyes.open("Furan Demo", "Google Home")
            driver.get("https://www.google.com/")
            eyes.check("home")
            eyes.close()
        } catch (e: Throwable) {
            eyes.abort()
            throw e
        } finally {
            driver.quit()
        }
    }
}
