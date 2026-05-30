package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DomPayloadTest {

    @Test
    fun `explicit override wins when sendDom is true`() {
        val out = resolveDomPayload(
            override = "<custom>",
            sendDom = true,
            capture = { error("capture should not run when override is present") },
        )
        assertEquals("<custom>", out)
    }

    @Test
    fun `explicit override wins even when sendDom is false`() {
        val out = resolveDomPayload(
            override = "<custom>",
            sendDom = false,
            capture = { error("capture should not run when override is present") },
        )
        assertEquals("<custom>", out)
    }

    @Test
    fun `sendDom false with no override returns null without invoking capture`() {
        var called = false
        val out = resolveDomPayload(
            override = null,
            sendDom = false,
            capture = { called = true; "<html>" },
        )
        assertNull(out)
        assertFalse(called, "capture must not be invoked when sendDom is false")
    }

    @Test
    fun `sendDom true with no override invokes capture and returns its bytes`() {
        var called = false
        val out = resolveDomPayload(
            override = null,
            sendDom = true,
            capture = { called = true; "<from-driver>" },
        )
        assertTrue(called)
        assertEquals("<from-driver>", out)
    }

    @Test
    fun `sendDom true with capture throwing returns null and swallows the error`() {
        val out = resolveDomPayload(
            override = null,
            sendDom = true,
            capture = { throw RuntimeException("driver disconnected") },
        )
        assertNull(out)
    }

    @Test
    fun `sendDom true with capture returning null propagates null`() {
        val out = resolveDomPayload(
            override = null,
            sendDom = true,
            capture = { null },
        )
        assertNull(out)
    }
}
