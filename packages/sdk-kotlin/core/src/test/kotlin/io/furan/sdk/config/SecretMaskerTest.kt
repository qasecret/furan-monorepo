package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SecretMaskerTest {

    @Test
    fun `masks values whose key matches secret name patterns`() {
        val map = mapOf(
            "furan.endpoint" to "https://x",
            "furan.apiKey" to "abc-123",
            "furan.apiToken" to "tok",
            "furan.password" to "p",
            "furan.signatureSecret" to "shh",
        )
        val masked = DefaultSecretMasker.mask(map)
        assertEquals("https://x", masked["furan.endpoint"])
        assertEquals("******", masked["furan.apiKey"])
        assertEquals("******", masked["furan.apiToken"])
        assertEquals("******", masked["furan.password"])
        assertEquals("******", masked["furan.signatureSecret"])
    }

    @Test
    fun `pattern match is case insensitive on the leaf key only`() {
        // "keyboardLayout" must NOT be masked just because it contains "key";
        // we match on the trailing camelCase token equaling a secret word.
        val masked = DefaultSecretMasker.mask(mapOf(
            "furan.keyboardLayout" to "qwerty",
            "furan.APIKEY" to "shh",
        ))
        assertEquals("qwerty", masked["furan.keyboardLayout"])
        assertEquals("******", masked["furan.APIKEY"])
    }

    @Test
    fun `null values pass through unmasked`() {
        val masked = DefaultSecretMasker.mask(mapOf("furan.apiKey" to null))
        assertEquals(null, masked["furan.apiKey"])
    }

    @Test
    fun `provenance dump masks secret values while preserving source`() {
        val provenance: Map<String, ConfigValue<*>> = mapOf(
            "furan.apiKey" to ConfigValue("abc-123", "env:FURAN_API_KEY", 100),
            "furan.endpoint" to ConfigValue("https://x", "env:FURAN_ENDPOINT", 100),
        )
        val masked = DefaultSecretMasker.maskProvenance(provenance)
        assertEquals("******", masked["furan.apiKey"]!!.value)
        assertEquals("env:FURAN_API_KEY", masked["furan.apiKey"]!!.source)
        assertEquals("https://x", masked["furan.endpoint"]!!.value)
    }
}
