package io.furan.sdk.playwright

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ScriptBridgeTest {
    @Test
    fun `wrapScript runs the body in an inner fn so a top-level return yields a value`() {
        assertEquals(
            "(a) => { return (function() { return document.title; }).apply(null, a); }",
            wrapScript("return document.title;"),
        )
    }

    @Test
    fun `wrapScript preserves arguments-indexed access`() {
        assertEquals(
            "(a) => { return (function() { window.scrollTo(0, arguments[0]); }).apply(null, a); }",
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
