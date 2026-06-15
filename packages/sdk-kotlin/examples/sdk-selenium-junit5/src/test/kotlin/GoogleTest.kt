import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.CheckpointOptions
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
      addArguments(
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-search-engine-choice-screen",
        "--lang=en-US",
      )
    }
    val driver = ChromeDriver(options)
    try {
      Furan.use(FuranConfig.fromClasspath(), driver, testName = "googleTest") { furan ->
        driver.get("https://www.google.com/")
        furan.snapshot("HomePage")

        val searchBox = WebDriverWait(driver, Duration.ofSeconds(10))
          .until(ExpectedConditions.elementToBeClickable(By.name("q")))
        searchBox.sendKeys("AI", Keys.RETURN)

        WebDriverWait(driver, Duration.ofSeconds(10))
          .until(ExpectedConditions.visibilityOfElementLocated(By.id("search")))
        furan.snapshot("searchResult", CheckpointOptions(matchTimeoutMs = 2000))
      }
    } finally {
      driver.quit()
    }
  }
}
