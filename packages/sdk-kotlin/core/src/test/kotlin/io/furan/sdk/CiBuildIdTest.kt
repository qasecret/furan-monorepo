package io.furan.sdk

import com.sun.net.httpserver.HttpServer
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.util.Collections

/**
 * How [FuranCapture.open] picks the build: [FuranConfig.ciBuildId] is sent to
 * `POST /projects/:id/builds` (the api finds or creates the build by it), and
 * [FuranConfig.buildId] skips that call. Runs against a local stub api.
 */
class CiBuildIdTest {

    private lateinit var server: HttpServer
    private val buildBodies = Collections.synchronizedList(mutableListOf<String>())
    private val runBodies = Collections.synchronizedList(mutableListOf<String>())

    @BeforeEach
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().decodeToString()
            val path = ex.requestURI.path
            val json = when {
                path.endsWith("/builds") -> {
                    buildBodies += body
                    """{"id":"3f1c9a2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b","projectId":"p"}"""
                }
                path.endsWith("/runs") -> {
                    runBodies += body
                    """{"runId":"run-${runBodies.size}","status":"running","name":"t"}"""
                }
                else -> "{}"
            }
            val bytes = json.encodeToByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(if (path.endsWith("/builds") || path.endsWith("/runs")) 201 else 200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterEach
    fun stop() = server.stop(0)

    private fun config(buildId: String? = null, ciBuildId: String? = null) = FuranConfig(
        apiUrl = "http://127.0.0.1:${server.address.port}",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "p",
        buildId = buildId,
        ciBuildId = ciBuildId,
        telemetryEnabled = false,
        logLevel = "none",
    )

    private object NoopDriver : SpecDriver {
        override fun getDriverInfo() = DriverInfo()
        override fun takeScreenshot() = ByteArray(0)
        override fun executeScript(script: String, vararg args: Any?): Any? = null
        override fun setViewportSize(size: Size) {}
        override fun findElement(selector: Selector): SpecElement? = null
    }

    @Test
    fun `every instance sends the ci build id, so the tests of a pipeline share one build`() {
        repeat(2) { FuranCapture(config(ciBuildId = "9012345678-1"), NoopDriver, "test").open("t$it") }
        assertEquals(2, buildBodies.size)
        buildBodies.forEach { assertTrue(it.contains("\"ciBuildId\":\"9012345678-1\""), it) }
        runBodies.forEach { assertTrue(it.contains("3f1c9a2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"), it) }
    }

    @Test
    fun `a build id attaches to that build without creating one`() {
        FuranCapture(config(buildId = "0b4c3a2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"), NoopDriver, "test").open("t")
        assertEquals(0, buildBodies.size)
        assertTrue(runBodies.single().contains("0b4c3a2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"))
    }
}
