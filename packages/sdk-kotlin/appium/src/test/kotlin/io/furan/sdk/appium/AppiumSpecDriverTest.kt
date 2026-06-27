package io.furan.sdk.appium

import io.appium.java_client.AppiumBy
import io.appium.java_client.AppiumDriver
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.kotlin.any
import org.mockito.kotlin.mock
import org.mockito.kotlin.whenever
import org.openqa.selenium.Capabilities
import org.openqa.selenium.Dimension
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.Point
import org.openqa.selenium.Rectangle
import org.openqa.selenium.WebElement

/**
 * Unit tests for the Appium→SPI adapter, mocking `AppiumDriver` so the native
 * capability advertisement, screenshot delegation, unsupported-op guards, and
 * selector mapping are verified without an Appium server or device.
 */
class AppiumSpecDriverTest {

    private fun driverWithCaps(platform: String?, device: String?, udid: String? = null): AppiumDriver {
        val caps = mock<Capabilities>()
        whenever(caps.getCapability("platformName")).thenReturn(platform)
        whenever(caps.getCapability("deviceName")).thenReturn(device)
        whenever(caps.getCapability("udid")).thenReturn(udid)
        val driver = mock<AppiumDriver>()
        whenever(driver.capabilities).thenReturn(caps)
        return driver
    }

    @Test
    fun `getDriverInfo reports a native mobile driver with platform-labelled browser + device`() {
        val info = AppiumSpecDriver(driverWithCaps("Android", "Pixel_7")).getDriverInfo()
        assertTrue(info.isNative)
        assertTrue(info.isMobile)
        assertEquals("android", info.browserName)
        assertEquals("Pixel_7", info.deviceName)
        assertEquals(null, info.platformName) // os left null in the MVP
        assertTrue(info.features.isEmpty())    // native: degraded path, no JS/DOM/resize
    }

    @Test
    fun `getDriverInfo falls back to udid for device and unknown for platform`() {
        val info = AppiumSpecDriver(driverWithCaps(platform = null, device = null, udid = "emulator-5554")).getDriverInfo()
        assertEquals(null, info.browserName)
        assertEquals("emulator-5554", info.deviceName)
    }

    @Test
    fun `getDriverInfo reads the appium-prefixed deviceName when the unprefixed cap is absent`() {
        val caps = mock<Capabilities>()
        whenever(caps.getCapability("platformName")).thenReturn("Android")
        whenever(caps.getCapability("deviceName")).thenReturn(null)
        whenever(caps.getCapability("appium:deviceName")).thenReturn("Pixel_7")
        val driver = mock<AppiumDriver>()
        whenever(driver.capabilities).thenReturn(caps)
        assertEquals("Pixel_7", AppiumSpecDriver(driver).getDriverInfo().deviceName)
    }

    @Test
    fun `getDriverInfo treats a blank deviceName as absent and falls back to udid`() {
        val info = AppiumSpecDriver(driverWithCaps(platform = "Android", device = "", udid = "emulator-5554")).getDriverInfo()
        assertEquals("emulator-5554", info.deviceName)
    }

    @Test
    fun `getDriverInfo lowercases a Platform-enum platformName`() {
        val caps = mock<Capabilities>()
        whenever(caps.getCapability("platformName")).thenReturn(org.openqa.selenium.Platform.ANDROID)
        val driver = mock<AppiumDriver>()
        whenever(driver.capabilities).thenReturn(caps)
        assertEquals("android", AppiumSpecDriver(driver).getDriverInfo().browserName)
    }

    @Test
    fun `takeScreenshot delegates to getScreenshotAs BYTES`() {
        val driver = mock<AppiumDriver>()
        whenever(driver.getScreenshotAs(OutputType.BYTES)).thenReturn(byteArrayOf(1, 2, 3))
        assertEquals(3, AppiumSpecDriver(driver).takeScreenshot().size)
    }

    @Test
    fun `executeScript is unsupported in native context`() {
        assertThrows(UnsupportedOperationException::class.java) {
            AppiumSpecDriver(mock()).executeScript("return 1;")
        }
    }

    @Test
    fun `setViewportSize is unsupported on a fixed mobile viewport`() {
        assertThrows(UnsupportedOperationException::class.java) {
            AppiumSpecDriver(mock()).setViewportSize(Size(100, 200))
        }
    }

    @Test
    fun `appiumBy maps AccessibilityId to AppiumBy, Xpath to By xpath, rejects Css`() {
        // AppiumBy does not override equals(), so assert on type + toString rather
        // than instance equality.
        val acc = appiumBy(Selector.AccessibilityId("home"))
        assertTrue(acc is AppiumBy, "accessibility id should map to an AppiumBy locator")
        assertTrue(acc.toString().contains("home"))

        val xp = appiumBy(Selector.Xpath("//android.widget.Button"))
        assertTrue(xp.toString().lowercase().contains("xpath"))
        assertTrue(xp.toString().contains("//android.widget.Button"))

        assertThrows(IllegalStateException::class.java) { appiumBy(Selector.Css(".btn")) }
    }

    @Test
    fun `findElement wraps the element rect and screenshot`() {
        val el = mock<WebElement>()
        whenever(el.rect).thenReturn(Rectangle(Point(10, 20), Dimension(30, 40))) // x,y / w,h
        whenever(el.getScreenshotAs(OutputType.BYTES)).thenReturn(byteArrayOf(7))
        val driver = mock<AppiumDriver>()
        whenever(driver.findElement(any())).thenReturn(el)

        val found = AppiumSpecDriver(driver).findElement(Selector.AccessibilityId("cart"))!!
        assertEquals(Rect(10, 20, 30, 40), found.boundingRect())
        assertEquals(7, found.elementScreenshot()[0])
    }

    @Test
    fun `findElement returns null on a miss`() {
        val driver = mock<AppiumDriver>()
        whenever(driver.findElement(any())).thenThrow(NoSuchElementException("nope"))
        assertNull(AppiumSpecDriver(driver).findElement(Selector.AccessibilityId("ghost")))
    }
}
