import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Loupe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.By
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * Demonstrates the test model: ONE test ("GoogleTest") that owns
 * MULTIPLE checkpoints (screens). `loupe.open(app, testName)` starts the test;
 * each `loupe.check(<screen name>)` captures one checkpoint within it. The
 * Builds list shows the test name ("GoogleTest"); the batch detail lists its
 * checkpoints ("home", "search-typed"). Skipped unless FURAN_API_URL is set.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class GoogleTest {
    @Test
    fun googleTest() {
        val driver = ChromeDriver(
            ChromeOptions().apply {
                addArguments(
                    "--headless=new",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--window-size=1280,900",
                    "--lang=en-US",
                )
            },
        )
        val loupe = Loupe(FuranConfig.fromEnv(), driver)
        try {
            // One test, named once at open().
            loupe.open("Furan Demo", "GoogleTest")

            // Checkpoint 1 — the home screen.
            driver.get("https://www.google.com/")
            loupe.check("home")

            // Checkpoint 2 — a different screen (search box filled).
            driver.findElement(By.name("q")).sendKeys("furan visual testing")
            loupe.check("search-typed")

            loupe.close()
        } catch (e: Throwable) {
            loupe.abort()
            throw e
        } finally {
            driver.quit()
        }
    }
}
