package io.furan.sdk.capture

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class DomCaptureTest {
    @Test
    fun `captures DOM via executeScript`() {
        val driver = FakeSpecDriver(
            onExecuteScript = { script, _ ->
                if ("outerHTML" in script) "<html>...</html>" else null
            },
        )
        assertEquals("<html>...</html>", captureDom(driver))
    }

    @Test
    fun `returns empty string when executeScript returns null`() {
        val driver = FakeSpecDriver(
            onExecuteScript = { _, _ -> null },
        )
        assertEquals("", captureDom(driver))
    }
}
