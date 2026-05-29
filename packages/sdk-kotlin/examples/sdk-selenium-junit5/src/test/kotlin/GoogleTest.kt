import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.Keys
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions
import org.openqa.selenium.support.ui.ExpectedConditions
import org.openqa.selenium.support.ui.WebDriverWait
import java.time.Duration

class GoogleTest {

  @Test
  fun googleTest() {
    val options = ChromeOptions().apply {
      addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
    }
    val driver = ChromeDriver(options)
    // SDK 2.0.0 constructor order: Furan(config, driver).
    // Furan.use handles open/close lifecycle; abort is called on any exception.
    Furan.use(FuranConfig.fromClasspath(), driver, testName = "googleTest") { furan ->
      driver.get("https://google.com")
      furan.snapshot("HomePage")
      // Submit via Keys.RETURN instead of clicking btnK: Google's
      // autocomplete dropdown can overlay btnK after sendKeys, making
      // the click unreliable. Then wait for the URL to indicate the
      // results page has committed before snapshotting — otherwise the
      // screenshot races navigation and Chrome aborts with
      // "Not attached to an active page".
      driver.findElement(By.name("q")).sendKeys("AI", Keys.RETURN)
      WebDriverWait(driver, Duration.ofSeconds(10))
        .until(ExpectedConditions.urlContains("search"))
      furan.snapshot("searchResult")
    }
    driver.quit()
  }
}
