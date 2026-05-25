package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ConfigPrimitivesTest {

    @Test
    fun `ConfigPriority constants are ordered ENV highest to DEFAULTS lowest`() {
        assertTrue(ConfigPriority.ENV > ConfigPriority.SYSPROP)
        assertTrue(ConfigPriority.SYSPROP > ConfigPriority.DEFAULTS)
        assertEquals(100, ConfigPriority.ENV)
        assertEquals(90, ConfigPriority.SYSPROP)
        assertEquals(10, ConfigPriority.DEFAULTS)
    }

    @Test
    fun `ConfigValue is a data class with structural equality`() {
        val a = ConfigValue(value = "https://x", source = "env:FURAN_API_URL", priority = 100)
        val b = ConfigValue(value = "https://x", source = "env:FURAN_API_URL", priority = 100)
        val c = ConfigValue(value = "https://y", source = "env:FURAN_API_URL", priority = 100)
        assertEquals(a, b)
        assertTrue(a != c)
    }

    @Test
    fun `ConfigSource is an interface with name priority and load`() {
        val src = object : ConfigSource {
            override val name = "fake"
            override val priority = 50
            override fun load(): Map<String, Any?> = mapOf("furan.x" to "y")
        }
        assertEquals("fake", src.name)
        assertEquals(50, src.priority)
        assertEquals("y", src.load()["furan.x"])
    }
}
