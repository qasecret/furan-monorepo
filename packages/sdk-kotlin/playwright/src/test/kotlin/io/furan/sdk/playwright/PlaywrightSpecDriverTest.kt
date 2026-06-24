package io.furan.sdk.playwright

import com.microsoft.playwright.ElementHandle
import com.microsoft.playwright.Page
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.mockito.kotlin.any
import org.mockito.kotlin.eq
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever

/**
 * Unit tests for the Playwright→SPI adapter, mocking `com.microsoft.playwright.Page`
 * so the mapping (script wrapping, selector translation, capability advertisement,
 * and the null-guard sentinels) is verified without a browser.
 */
class PlaywrightSpecDriverTest {

    @Test
    fun `executeScript wraps the body and passes args as one list to page evaluate`() {
        val page = mock<Page>()
        whenever(page.evaluate(any(), any())).thenReturn("ok")

        val result = PlaywrightSpecDriver(page).executeScript("return arguments[0];", 42)

        assertEquals("ok", result)
        verify(page).evaluate(
            eq("(a) => { return (function() { return arguments[0]; }).apply(null, a); }"),
            eq(listOf<Any?>(42)),
        )
    }

    @Test
    fun `takeScreenshot delegates to page screenshot`() {
        val page = mock<Page>()
        whenever(page.screenshot()).thenReturn(byteArrayOf(1, 2, 3))
        assertEquals(3, PlaywrightSpecDriver(page).takeScreenshot().size)
    }

    @Test
    fun `setViewportSize delegates to page`() {
        val page = mock<Page>()
        PlaywrightSpecDriver(page).setViewportSize(Size(800, 600))
        verify(page).setViewportSize(800, 600)
    }

    @Test
    fun `findElement returns null when querySelector misses`() {
        val page = mock<Page>()
        whenever(page.querySelector(any())).thenReturn(null)
        assertNull(PlaywrightSpecDriver(page).findElement(Selector.Css(".nope")))
    }

    @Test
    fun `findElement translates an xpath selector and wraps the handle`() {
        val page = mock<Page>()
        val handle = mock<ElementHandle>()
        whenever(page.querySelector("xpath=//a")).thenReturn(handle)
        whenever(handle.screenshot()).thenReturn(byteArrayOf(9))

        val el = PlaywrightSpecDriver(page).findElement(Selector.Xpath("//a"))
        assertEquals(9, el!!.elementScreenshot()[0])
    }

    @Test
    fun `boundingRect falls back to a zero rect for a detached element`() {
        val page = mock<Page>()
        val handle = mock<ElementHandle>()
        whenever(page.querySelector(any())).thenReturn(handle)
        whenever(handle.boundingBox()).thenReturn(null) // detached / not rendered

        val el = PlaywrightSpecDriver(page).findElement(Selector.Css(".gone"))!!
        assertEquals(Rect(0, 0, 0, 0), el.boundingRect())
    }

    @Test
    fun `getDriverInfo advertises web features and labels the browser per type`() {
        val page = mock<Page>(defaultAnswer = Mockito.RETURNS_DEEP_STUBS)
        whenever(page.context().browser().browserType().name()).thenReturn("chromium")
        // RETURNS_DEEP_STUBS leaves viewportSize() non-null by default.

        val info = PlaywrightSpecDriver(page).getDriverInfo()

        assertEquals("playwright-chromium", info.browserName)
        assertFalse(info.isNative)
        assertTrue(
            info.features.containsAll(
                setOf(
                    Feature.JAVASCRIPT,
                    Feature.DOM_SNAPSHOT,
                    Feature.ELEMENT_SCREENSHOT,
                    Feature.RESIZE_VIEWPORT,
                ),
            ),
        )
    }

    @Test
    fun `getDriverInfo withholds RESIZE_VIEWPORT when the page has no viewport`() {
        val page = mock<Page>(defaultAnswer = Mockito.RETURNS_DEEP_STUBS)
        whenever(page.context().browser().browserType().name()).thenReturn("firefox")
        whenever(page.viewportSize()).thenReturn(null) // viewport:null context (OS window size)

        val info = PlaywrightSpecDriver(page).getDriverInfo()

        assertEquals("playwright-firefox", info.browserName)
        assertFalse(Feature.RESIZE_VIEWPORT in info.features)
        // JS / DOM / element capture stay advertised — only resize is gated.
        assertTrue(Feature.JAVASCRIPT in info.features)
    }
}
