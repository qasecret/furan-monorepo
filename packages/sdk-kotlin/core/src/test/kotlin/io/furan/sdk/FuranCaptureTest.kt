package io.furan.sdk

import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class FuranCaptureTest {
    // cfg() mirrors FuranLifecycleTest.testConfig(): unreachable URL, no telemetry.
    private fun cfg() = FuranConfig(
        apiUrl = "http://127.0.0.1:1", // unreachable — tests must not hit it
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
    )

    private fun capture() = FuranCapture(cfg(), NoopSpecDriver, adapter = "test")

    @Test fun `snapshot before open throws`() {
        assertThrows(IllegalStateException::class.java) { capture().snapshot("x") }
    }

    @Test fun `snapshotAndAwait before open throws`() {
        assertThrows(IllegalStateException::class.java) { capture().snapshotAndAwait("x") }
    }

    @Test fun `close with no open run returns null`() {
        assertNull(capture().close())
    }

    @Test fun `abort with no open run is idempotent`() {
        capture().abort()
    }

    private object NoopSpecDriver : SpecDriver {
        override fun getDriverInfo() = DriverInfo()
        override fun takeScreenshot() = ByteArray(0)
        override fun executeScript(script: String, vararg args: Any?): Any? = null
        override fun setViewportSize(size: Size) {}
        override fun findElement(selector: Selector): SpecElement? = null
    }
}
