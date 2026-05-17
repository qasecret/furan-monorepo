package io.furan.sdk.log

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class RedactorTest {
    @Test
    fun `masks furan_pat tokens`() {
        val raw = "Calling api with token furan_pat_abc123def456ghi789jkl012mno345pqr"
        assertEquals("Calling api with token [REDACTED]", redact(raw))
    }

    @Test
    fun `masks Authorization header values`() {
        val raw = "Authorization: Bearer eyJ0eXAi..."
        assertEquals("Authorization: [REDACTED]", redact(raw))
    }

    @Test
    fun `leaves unrelated text alone`() {
        val raw = "normal log line"
        assertEquals(raw, redact(raw))
    }

    @Test
    fun `does not mask short or invalid token-looking strings`() {
        val raw = "furan_pat_short"   // less than 20 chars after prefix
        assertEquals(raw, redact(raw))
    }
}
