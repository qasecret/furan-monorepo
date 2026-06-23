package io.furan.sdk.playwright

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ScriptBridgeTest {
    @Test
    fun `wrapScript wraps the body in an arrow fn whose param is named arguments`() {
        assertEquals(
            "(arguments) => { return document.title; }",
            wrapScript("return document.title;"),
        )
    }

    @Test
    fun `wrapScript preserves arguments-indexed access`() {
        assertEquals(
            "(arguments) => { window.scrollTo(0, arguments[0]); }",
            wrapScript("window.scrollTo(0, arguments[0]);"),
        )
    }

    @Test
    fun `playwrightBrowserLabel prefixes the browser type`() {
        assertEquals("playwright-chromium", playwrightBrowserLabel("chromium"))
        assertEquals("playwright-firefox", playwrightBrowserLabel("firefox"))
        assertEquals("playwright-webkit", playwrightBrowserLabel("webkit"))
    }

    @Test
    fun `playwrightBrowserLabel falls back when type is unknown`() {
        assertEquals("playwright", playwrightBrowserLabel(null))
        assertEquals("playwright", playwrightBrowserLabel(""))
    }
}
