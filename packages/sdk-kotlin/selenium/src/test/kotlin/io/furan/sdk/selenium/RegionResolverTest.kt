package io.furan.sdk.selenium

import io.furan.sdk.dto.Region
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test
import org.openqa.selenium.By
import org.openqa.selenium.NoSuchElementException
import org.openqa.selenium.OutputType
import org.openqa.selenium.Rectangle
import org.openqa.selenium.TakesScreenshot
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement

class RegionResolverTest {

    @Test
    fun `selector-less region passes through unchanged`() {
        val driver = ResolverDriver(elements = emptyMap())
        val r = Region(x = 10.0, y = 20.0, width = 30.0, height = 40.0)
        val resolved = resolveRegion(driver, r)
        assertSame(r, resolved)
    }

    @Test
    fun `selector resolves to element bbox`() {
        val element = ResolverElement(rect = Rectangle(100, 200, 60, 80), pngBytes = byteArrayOf())
        val driver = ResolverDriver(elements = mapOf(".target" to element))
        val r = Region.bySelector(".target")
        val resolved = resolveRegion(driver, r)
        assertEquals(100.0, resolved.x)
        assertEquals(200.0, resolved.y)
        assertEquals(80.0, resolved.width)
        assertEquals(60.0, resolved.height)
        assertEquals(".target", resolved.selector)
    }

    @Test
    fun `selector miss falls back to original geometry`() {
        val driver = ResolverDriver(elements = emptyMap())
        val r = Region.bySelector(
            css = ".missing",
            fallbackX = 5.0,
            fallbackY = 6.0,
            fallbackWidth = 7.0,
            fallbackHeight = 8.0,
        )
        val resolved = resolveRegion(driver, r)
        assertEquals(5.0, resolved.x)
        assertEquals(6.0, resolved.y)
        assertEquals(7.0, resolved.width)
        assertEquals(8.0, resolved.height)
    }

    @Test
    fun `bySelector factory sets selector and zero geometry by default`() {
        val r = Region.bySelector(".thing")
        assertEquals(".thing", r.selector)
        assertEquals(0.0, r.x)
        assertEquals(0.0, r.y)
        assertEquals(0.0, r.width)
        assertEquals(0.0, r.height)
    }

    @Test
    fun `captureElementScreenshot returns the element bytes`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val element = ResolverElement(rect = Rectangle(0, 0, 10, 10), pngBytes = png)
        val driver = ResolverDriver(elements = mapOf(".pic" to element))
        val result = captureElementScreenshot(driver, ".pic")
        assertEquals(png.size, result.size)
        for (i in png.indices) assertEquals(png[i], result[i])
    }
}

private class ResolverDriver(private val elements: Map<String, WebElement>) :
    WebDriver, TakesScreenshot {
    override fun get(url: String) = Unit
    override fun getCurrentUrl(): String = ""
    override fun getTitle(): String = ""
    override fun findElements(by: By): List<WebElement> = emptyList()
    override fun findElement(by: By): WebElement {
        // Match Selenium's By.cssSelector toString: "By.cssSelector: <css>".
        val css = by.toString().substringAfter("By.cssSelector: ", missingDelimiterValue = "")
        return elements[css] ?: throw NoSuchElementException("no element for $by")
    }
    override fun getPageSource(): String = ""
    override fun close() = Unit
    override fun quit() = Unit
    override fun getWindowHandles(): Set<String> = emptySet()
    override fun getWindowHandle(): String = ""
    override fun switchTo(): WebDriver.TargetLocator = throw NotImplementedError()
    override fun navigate(): WebDriver.Navigation = throw NotImplementedError()
    override fun manage(): WebDriver.Options = throw NotImplementedError()

    @Suppress("UNCHECKED_CAST")
    override fun <X : Any> getScreenshotAs(target: OutputType<X>): X = ByteArray(0) as X
}

private class ResolverElement(
    private val rect: Rectangle,
    private val pngBytes: ByteArray,
) : WebElement {
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
    override fun getSize(): org.openqa.selenium.Dimension =
        org.openqa.selenium.Dimension(rect.width, rect.height)
    override fun getRect(): Rectangle = rect
    override fun getCssValue(propertyName: String?): String = ""

    @Suppress("UNCHECKED_CAST")
    override fun <X : Any> getScreenshotAs(target: OutputType<X>): X = pngBytes as X
}
