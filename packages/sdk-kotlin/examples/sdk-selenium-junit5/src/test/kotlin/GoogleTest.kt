import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

class GoogleTest {

  @Test
  fun googleTest() {
    val options = ChromeOptions().apply {
      addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
    }
    val driver = ChromeDriver(options)
    val furan = Furan(driver, FuranConfig.fromClasspath())
    try {
      driver.get("https://google.com")
      furan.snapshot("HomePage")
      driver.findElement(By.name("q")).sendKeys("AI")
      driver.findElement(By.name("btnK")).click()
      furan.snapshot("searchResult")
    } finally {
      furan.close()
      driver.quit()
    }
  }
}
