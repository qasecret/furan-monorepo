package io.furan.sdk.auth

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class TokenTest {
    @Test
    fun `builds bearer header`() {
        assertEquals("Bearer furan_pat_test", bearerHeader("furan_pat_test"))
    }

    @Test
    fun `rejects blank token`() {
        assertThrows<IllegalArgumentException> { bearerHeader("  ") }
    }

    @Test
    fun `rejects empty token`() {
        assertThrows<IllegalArgumentException> { bearerHeader("") }
    }
}
