import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

/**
 * End-to-end fixture for Tier 3 fully-page stitching. The data: URL
 * renders a page taller than the viewport (5 stacked colored blocks of
 * 800px each = 4000px document). With fully = true the captured PNG
 * should be ~4000px tall; with fully = false (default) it would be one
 * viewport tall.
 *
 * Skipped unless FURAN_API_URL is set, matching the rest of the
 * example tests.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class FullyPageStitchTest {

    private val tallPage: String =
        "data:text/html," +
            "<html><body style=\"margin:0\">" +
            "<div style=\"height:800px;background:red\"></div>" +
            "<div style=\"height:800px;background:orange\"></div>" +
            "<div style=\"height:800px;background:yellow\"></div>" +
            "<div style=\"height:800px;background:green\"></div>" +
            "<div style=\"height:800px;background:blue\"></div>" +
            "</body></html>"

    @Test
    fun `fully = true captures the entire 4000px document`() {
        val driver = ChromeDriver(
            ChromeOptions().apply {
                addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
            },
        )
        try {
            Furan.use(FuranConfig.fromEnv(), driver, testName = "fully = true captures the entire 4000px document") { furan ->
                driver.get(tallPage)
                furan.snapshot("tall-page-fully", CheckpointOptions(fully = true))
            }
        } finally {
            driver.quit()
        }
    }

    @Test
    fun `fully + hideFixedElements suppresses a sticky banner during stitch`() {
        val driver = ChromeDriver(
            ChromeOptions().apply {
                addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
            },
        )
        try {
            Furan.use(FuranConfig.fromEnv(), driver, testName = "fully + hideFixedElements suppresses a sticky banner during stitch") { furan ->
                driver.get(
                    "data:text/html," +
                        "<html><body style=\"margin:0\">" +
                        "<header id=\"sticky\" style=\"position:fixed;top:0;left:0;right:0;height:60px;background:black;color:white\">STICKY</header>" +
                        "<div style=\"height:1200px;background:lightblue\"></div>" +
                        "<div style=\"height:1200px;background:lightgreen\"></div>" +
                        "<div style=\"height:1200px;background:lightcoral\"></div>" +
                        "</body></html>",
                )
                furan.snapshot(
                    "sticky-banner-hidden",
                    CheckpointOptions(
                        fully = true,
                        hideFixedElements = listOf("#sticky"),
                    ),
                )
            }
        } finally {
            driver.quit()
        }
    }
}
