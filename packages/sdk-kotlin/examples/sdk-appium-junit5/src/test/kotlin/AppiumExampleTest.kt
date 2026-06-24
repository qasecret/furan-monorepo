import io.appium.java_client.AppiumDriver
import io.furan.sdk.FuranConfig
import io.furan.sdk.appium.FuranAppium
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.remote.DesiredCapabilities
import java.net.URI

/**
 * Smoke example for the Furan Appium adapter — a native full-screen snapshot
 * via the `snapshotAndAwait` path that blocks until the diff worker produces a
 * terminal status.
 *
 * Skipped unless `FURAN_API_URL` is set (the SDK needs a running apps/api + a
 * PAT), AND it requires a reachable Appium server + device/emulator running the
 * app under test (configured via the APPIUM_* env vars — see
 * local.properties.example). CI compiles this file but never runs it, since the
 * runner has no emulator. To run it locally:
 *
 *   FURAN_API_URL=http://localhost:3000 FURAN_API_TOKEN=... FURAN_PROJECT_ID=... \
 *   APPIUM_SERVER_URL=http://localhost:4723 APPIUM_APP_PACKAGE=com.example.app \
 *   APPIUM_APP_ACTIVITY=com.example.app.MainActivity ./gradlew test
 *
 * `browserName` is reported as `appium-android` so the run keeps a separate
 * baseline from iOS / the web adapters.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class AppiumExampleTest {
    @Test
    fun `appium native snapshot round-trip`() {
        val serverUrl = System.getenv("APPIUM_SERVER_URL") ?: "http://localhost:4723"
        val caps = DesiredCapabilities().apply {
            setCapability("platformName", System.getenv("APPIUM_PLATFORM") ?: "Android")
            setCapability("appium:automationName", System.getenv("APPIUM_AUTOMATION") ?: "UiAutomator2")
            setCapability("appium:deviceName", System.getenv("APPIUM_DEVICE") ?: "Android Emulator")
            System.getenv("APPIUM_APP")?.let { setCapability("appium:app", it) }
            System.getenv("APPIUM_APP_PACKAGE")?.let { setCapability("appium:appPackage", it) }
            System.getenv("APPIUM_APP_ACTIVITY")?.let { setCapability("appium:appActivity", it) }
        }
        // AppiumDriver (the base type FuranAppium accepts) keeps the example
        // independent of the Selenium version that java-client resolves; the
        // AndroidDriver / IOSDriver subclasses work too when you need their
        // platform-specific methods.
        val driver = AppiumDriver(URI(serverUrl).toURL(), caps)
        try {
            val result = FuranAppium.use(FuranConfig.fromEnv(), driver, "appium smoke") { furan ->
                furan.snapshotAndAwait("home")
            }
            assertTrue(result.checkpointId.isNotBlank())
        } finally {
            driver.quit()
        }
    }
}
