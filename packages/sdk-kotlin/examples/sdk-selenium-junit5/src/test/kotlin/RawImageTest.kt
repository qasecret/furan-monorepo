import io.furan.sdk.FuranConfig
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.images.FuranImages
import io.furan.sdk.images.ImageCheckpointOptions
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import javax.imageio.ImageIO

/**
 * Driverless visual testing: no WebDriver, no browser — just images.
 * Demonstrates all three input forms (ByteArray, File, BufferedImage) across
 * both the fire-and-forget and the blocking (await) styles.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class RawImageTest {

    private fun render(text: String): BufferedImage {
        val img = BufferedImage(400, 200, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = Color.WHITE
        g.fillRect(0, 0, 400, 200)
        g.color = Color.BLACK
        g.drawString(text, 20, 100)
        g.dispose()
        return img
    }

    private fun png(image: BufferedImage): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "png", out)
        return out.toByteArray()
    }

    /**
     * Fire-and-forget: several checkpoints (one per input form) in a single
     * run; `use {}` completes the run on the way out. Each `checkImage` uploads
     * without waiting, so the result never depends on the run's aggregate
     * status mid-run.
     */
    @Test
    fun `checks raw images with no WebDriver`() {
        val options = ImageCheckpointOptions(browser = "raw-image-example", os = "ci")

        FuranImages.use(FuranConfig.fromEnv(), testName = "raw images (fire-and-forget)") { furan ->
            furan.checkImage("home-bytes", png(render("Home")), options)

            val file = Files.createTempFile("furan-example", ".png").toFile()
            try {
                file.writeBytes(png(render("Profile")))
                furan.checkImage("profile-file", file, options)
            } finally {
                file.delete()
            }

            furan.checkImage("settings-bufferedimage", render("Settings"), options)
        }
    }

    /**
     * Blocking: a single checkpoint per run, then inspect the verdict.
     * `softAssert = true` so a first run (no baseline yet) returns the NEW
     * result instead of throwing FuranNoBaselineException.
     */
    @Test
    fun `awaits a single raw-image checkpoint`() {
        val config = FuranConfig.fromEnv().copy(softAssert = true)
        val options = ImageCheckpointOptions(browser = "raw-image-example", os = "ci")

        val result = FuranImages.use(config, testName = "raw image (await)") { furan ->
            furan.checkImageAndAwait("home-await", png(render("Home")), options)
        }
        println("[furan] home-await -> ${result.status} ${result.diffViewerUrl ?: ""}")
        // awaitRunResult only returns once the run has settled (or throws on
        // timeout), so the status is never RUNNING here — NEW (first run) or a
        // terminal verdict.
        assertNotEquals(RunStatus.RUNNING, result.status)
    }
}
