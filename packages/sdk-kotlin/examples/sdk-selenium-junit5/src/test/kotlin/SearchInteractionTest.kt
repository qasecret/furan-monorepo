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

/**
 * Demonstrates a multi-snapshot flow with an interaction in between: snapshot a
 * page, type into a field and submit, wait for the result to appear, then
 * snapshot again — so the two checkpoints differ visually.
 *
 * Navigates to a self-contained `data:` URL rather than a live website, so the
 * example is deterministic in CI (no network, no cookie-consent banners, no
 * bot-detection). This previously pointed at live google.com and flaked
 * constantly on CI runners — google's consent / bot screens left the search
 * box (or results) unreachable and Selenium threw a TimeoutException.
 */
class SearchInteractionTest {

  // Tiny self-contained page: a search box that reveals a results panel when
  // the user presses Enter. Mirrors a real search → results flow with no
  // external dependency. (Inline `onkeydown` runs because data: URLs carry no
  // content-security-policy.)
  private val searchPage =
    """data:text/html,<html><body><h1>Search</h1><input name="q" id="q" autofocus onkeydown="if(event.key==='Enter'){document.getElementById('search').style.display='block'}"/><div id="search" style="display:none"><h2>Results</h2><p>Result for AI</p></div></body></html>"""

  @Test
  fun searchInteraction() {
    val options = ChromeOptions().apply {
      addArguments(
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--lang=en-US",
      )
    }
    val driver = ChromeDriver(options)
    try {
      Furan.use(FuranConfig.fromClasspath(), driver, testName = "searchInteraction") { furan ->
        driver.get(searchPage)
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
