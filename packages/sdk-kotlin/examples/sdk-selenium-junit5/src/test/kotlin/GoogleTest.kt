import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.chrome.ChromeDriver

class GoogleTest {

  @Test
  fun googleTest() {
    val driver = ChromeDriver()
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
