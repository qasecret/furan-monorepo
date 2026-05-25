package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ConfigurationResolverTest {

    private class FakeSource(
        override val name: String,
        override val priority: Int,
        private val data: Map<String, Any?>,
    ) : ConfigSource {
        override fun load(): Map<String, Any?> = data
    }

    @Test
    fun `single source flows through with its name as provenance`() {
        val src = FakeSource("env", 100, mapOf("furan.endpoint" to "https://x"))
        val registry = ConfigurationResolver(listOf(src)).resolve()
        val cv = registry.get<String>("furan.endpoint")
        assertEquals("https://x", cv?.value)
        assertEquals("env", cv?.source)
        assertEquals(100, cv?.priority)
    }

    @Test
    fun `higher priority overrides and provenance reflects winner`() {
        val low = FakeSource("defaults", 10, mapOf("furan.endpoint" to "https://low"))
        val high = FakeSource("env", 100, mapOf("furan.endpoint" to "https://high"))
        val registry = ConfigurationResolver(listOf(low, high)).resolve()
        val cv = registry.get<String>("furan.endpoint")
        assertEquals("https://high", cv?.value)
        assertEquals("env", cv?.source)
        assertEquals(100, cv?.priority)
    }

    @Test
    fun `null clear by higher priority preserves the key but value is null`() {
        val low = FakeSource("yaml", 60, mapOf("furan.transport.proxy" to "http://corp:3128"))
        val high = FakeSource("env", 100, mapOf("furan.transport.proxy" to null))
        val registry = ConfigurationResolver(listOf(low, high)).resolve()
        val cv = registry.get<String>("furan.transport.proxy")
        assertTrue(registry.provenance().containsKey("furan.transport.proxy"))
        assertNull(cv?.value)
        assertEquals("env", cv?.source)
    }

    @Test
    fun `keys present only in lower priority retain their source`() {
        val defaults = FakeSource("defaults", 10, mapOf(
            "furan.retry.maxAttempts" to 3,
            "furan.transport.gzip" to true,
        ))
        val env = FakeSource("env", 100, mapOf("furan.retry.maxAttempts" to 5))
        val registry = ConfigurationResolver(listOf(defaults, env)).resolve()
        assertEquals("env", registry.get<Int>("furan.retry.maxAttempts")?.source)
        assertEquals("defaults", registry.get<Boolean>("furan.transport.gzip")?.source)
    }

    @Test
    fun `sources are sorted internally so caller may pass in any order`() {
        val low = FakeSource("defaults", 10, mapOf("furan.endpoint" to "https://low"))
        val high = FakeSource("env", 100, mapOf("furan.endpoint" to "https://high"))
        // Pass HIGH first.
        val registry = ConfigurationResolver(listOf(high, low)).resolve()
        assertEquals("https://high", registry.get<String>("furan.endpoint")?.value)
    }

    @Test
    fun `empty source list returns an empty registry`() {
        val registry = ConfigurationResolver(emptyList()).resolve()
        assertEquals(emptyMap<String, ConfigValue<*>>(), registry.provenance())
    }
}
