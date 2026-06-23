package io.furan.sdk.selenium

import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.Rectangle
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class SeleniumSpecDriverTest {
    @Test
    fun `getDriverInfo freezes browserName to selenium and advertises web features`() {
        val info = SeleniumSpecDriver(SpecStubDriver(emptyMap())).getDriverInfo()
        assertEquals("selenium", info.browserName)  // invariant 1 — do not change
        assertEquals(null, info.platformName)
        assertEquals(null, info.deviceName)
        assertEquals(false, info.isNative)
        assertTrue(info.features.containsAll(
            setOf(Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT, Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT),
        ))
    }

    @Test
    fun `findElement maps Css to By_cssSelector and exposes rect + screenshot`() {
        val el = StubElement(Rectangle(/* x */ 10, /* y */ 20, /* height */ 40, /* width */ 30), byteArrayOf(7))
        val driver = SeleniumSpecDriver(SpecStubDriver(mapOf("By.cssSelector: .t" to el)))
        val found = driver.findElement(Selector.Css(".t"))!!
        assertEquals(Rect(10, 20, 30, 40), found.boundingRect())
        assertEquals(7, found.elementScreenshot()[0])
    }

    @Test
    fun `findElement returns null when the selector misses`() {
        val driver = SeleniumSpecDriver(SpecStubDriver(emptyMap()))
        assertNull(driver.findElement(Selector.Css(".nope")))
    }

    @Test
    fun `findElement rejects AccessibilityId on web`() {
        val driver = SeleniumSpecDriver(SpecStubDriver(emptyMap()))
        assertThrows(IllegalStateException::class.java) {
            driver.findElement(Selector.AccessibilityId("home"))
        }
    }

    @Test
    fun `takeScreenshot and executeScript delegate to the driver`() {
        val driver = SeleniumSpecDriver(SpecStubDriver(emptyMap(), screenshot = byteArrayOf(1, 2)))
        assertEquals(2, driver.takeScreenshot().size)
        assertEquals("ok", driver.executeScript("return 'ok';"))
    }

    private class SpecStubDriver(
        private val elements: Map<String, WebElement>,
        private val screenshot: ByteArray = ByteArray(0),
    ) : WebDriver, org.openqa.selenium.JavascriptExecutor, TakesScreenshot {
        override fun findElement(by: By): WebElement =
            elements[by.toString()] ?: throw NoSuchElementException("no element for $by")
        override fun executeScript(script: String, vararg args: Any?): Any? = "ok"
        override fun executeAsyncScript(script: String, vararg args: Any?): Any? = null
        @Suppress("UNCHECKED_CAST")
        override fun <X : Any> getScreenshotAs(target: OutputType<X>): X = screenshot as X
        override fun get(url: String) = Unit
        override fun getCurrentUrl(): String = ""
        override fun getTitle(): String = ""
        override fun findElements(by: By): List<WebElement> = emptyList()
        override fun getPageSource(): String = ""
        override fun close() = Unit
        override fun quit() = Unit
        override fun getWindowHandles(): Set<String> = emptySet()
        override fun getWindowHandle(): String = ""
        override fun switchTo(): WebDriver.TargetLocator = throw NotImplementedError()
        override fun navigate(): WebDriver.Navigation = throw NotImplementedError()
        override fun manage(): WebDriver.Options = throw NotImplementedError()
    }

    private class StubElement(private val rect: Rectangle, private val png: ByteArray) : WebElement {
        override fun getRect(): Rectangle = rect
        @Suppress("UNCHECKED_CAST")
        override fun <X : Any> getScreenshotAs(target: OutputType<X>): X = png as X
        override fun click() = Unit
        override fun submit() = Unit
        override fun sendKeys(vararg keysToSend: CharSequence?) = Unit
        override fun clear() = Unit
        override fun getTagName(): String = "div"
        override fun getDomProperty(name: String?): String? = null
        override fun getDomAttribute(name: String?): String? = null
        override fun getAttribute(name: String?): String? = null
        override fun getAriaRole(): String = ""
        override fun getAccessibleName(): String = ""
        override fun isSelected(): Boolean = false
        override fun isEnabled(): Boolean = true
        override fun getText(): String = ""
        override fun findElements(by: By): List<WebElement> = emptyList()
        override fun findElement(by: By): WebElement = throw NotImplementedError()
        override fun getShadowRoot(): org.openqa.selenium.SearchContext = throw NotImplementedError()
        override fun isDisplayed(): Boolean = true
        override fun getLocation(): org.openqa.selenium.Point = org.openqa.selenium.Point(rect.x, rect.y)
        override fun getSize(): org.openqa.selenium.Dimension = org.openqa.selenium.Dimension(rect.width, rect.height)
        override fun getCssValue(propertyName: String?): String = ""
    }
}
