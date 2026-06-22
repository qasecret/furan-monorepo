import io.furan.sdk.FuranConfig
import io.furan.sdk.images.FuranImages
import io.furan.sdk.images.ImageCheckpointOptions
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import javax.imageio.ImageIO

/**
 * Driverless visual testing: no WebDriver, no browser — just images.
 * Demonstrates the three input forms (ByteArray, File, BufferedImage).
 * softAssert=true so a first run (no baseline) returns instead of throwing.
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

    @Test
    fun `checks raw images with no WebDriver`() {
        val config = FuranConfig.fromEnv().copy(softAssert = true)
        val options = ImageCheckpointOptions(browser = "raw-image-example", os = "ci")

        FuranImages.use(config, testName = "raw image example") { furan ->
            val fromBytes = furan.checkImageAndAwait("home-bytes", png(render("Home")), options)
            println("[furan] home-bytes -> ${fromBytes.status} ${fromBytes.diffViewerUrl ?: ""}")
            assertTrue(fromBytes.status.isTerminal())

            val file = Files.createTempFile("furan-example", ".png").toFile()
            file.writeBytes(png(render("Profile")))
            file.deleteOnExit()
            val fromFile = furan.checkImageAndAwait("profile-file", file, options)
            println("[furan] profile-file -> ${fromFile.status}")
            assertTrue(fromFile.status.isTerminal())

            val fromBufferedImage = furan.checkImageAndAwait("settings-bufferedimage", render("Settings"), options)
            println("[furan] settings-bufferedimage -> ${fromBufferedImage.status}")
            assertTrue(fromBufferedImage.status.isTerminal())
        }
    }
}
