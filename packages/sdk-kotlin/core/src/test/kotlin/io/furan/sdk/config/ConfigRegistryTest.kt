package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ConfigRegistryTest {

    private fun registry(values: Map<String, ConfigValue<*>>): ConfigRegistry =
        DefaultConfigRegistry(values)

    @Test
    fun `get returns the ConfigValue when present`() {
        val r = registry(mapOf(
            "furan.endpoint" to ConfigValue("https://x", "env:FURAN_ENDPOINT", 100),
        ))
        val cv = r.get<String>("furan.endpoint")
        assertEquals("https://x", cv?.value)
        assertEquals("env:FURAN_ENDPOINT", cv?.source)
        assertEquals(100, cv?.priority)
    }

    @Test
    fun `get returns null when absent`() {
        assertNull(registry(emptyMap()).get<String>("furan.missing"))
    }

    @Test
    fun `provenance returns the full map`() {
        val m = mapOf(
            "furan.endpoint" to ConfigValue("https://x", "env", 100),
            "furan.project" to ConfigValue("p", "yaml", 60),
        )
        assertEquals(m, registry(m).provenance())
    }

    @Test
    fun `dump renders one line per key with masked secrets`() {
        val r = registry(linkedMapOf(
            "furan.endpoint" to ConfigValue("https://x", "env:FURAN_ENDPOINT", 100),
            "furan.apiKey" to ConfigValue("abc-123", "env:FURAN_API_KEY", 100),
        ))
        val out = r.dump(masked = true)
        assertTrue(out.contains("furan.endpoint"))
        assertTrue(out.contains("https://x"))
        assertTrue(out.contains("env:FURAN_ENDPOINT"))
        assertTrue(out.contains("p=100"))
        assertTrue(out.contains("furan.apiKey"))
        assertTrue(out.contains("******"))
        assertTrue(!out.contains("abc-123"))
    }

    @Test
    fun `dump with masked false reveals secret values`() {
        val r = registry(mapOf(
            "furan.apiKey" to ConfigValue("abc-123", "env:FURAN_API_KEY", 100),
        ))
        val out = r.dump(masked = false)
        assertTrue(out.contains("abc-123"))
    }
}
