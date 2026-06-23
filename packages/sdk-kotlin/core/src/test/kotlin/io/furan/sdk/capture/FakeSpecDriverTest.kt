package io.furan.sdk.capture

import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class FakeSpecDriverTest {
    @Test
    fun `records scripts, screenshots and viewport calls`() {
        val driver = FakeSpecDriver(
            onTakeScreenshot = { byteArrayOf(1, 2, 3) },
            onExecuteScript = { script, _ -> if ("scrollHeight" in script) 4000L else null },
        )
        assertEquals(4000L, driver.executeScript("return document.documentElement.scrollHeight;"))
        assertEquals(3, driver.takeScreenshot().size)
        driver.setViewportSize(io.furan.sdk.spec.Size(800, 600))
        assertEquals(1, driver.executedScripts.size)
        assertEquals(1, driver.screenshotCount)
        assertEquals(listOf(io.furan.sdk.spec.Size(800, 600)), driver.setViewportCalls)
    }

    @Test
    fun `findElement returns mapped element or null`() {
        val el = FakeSpecElement(Rect(1, 2, 3, 4), byteArrayOf(9))
        val driver = FakeSpecDriver(elements = mapOf(".x" to el))
        assertEquals(Rect(1, 2, 3, 4), driver.findElement(Selector.Css(".x"))?.boundingRect())
        assertNull(driver.findElement(Selector.Css(".missing")))
    }

    @Test
    fun `getDriverInfo returns the configured info`() {
        val info = DriverInfo(isNative = true, features = setOf(Feature.NATIVE_ELEMENTS))
        assertEquals(info, FakeSpecDriver(driverInfo = info).getDriverInfo())
    }
}
