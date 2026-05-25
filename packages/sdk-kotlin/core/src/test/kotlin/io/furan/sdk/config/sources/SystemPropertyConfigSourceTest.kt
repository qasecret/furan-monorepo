package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.Properties

class SystemPropertyConfigSourceTest {

    private fun srcFrom(props: Map<String, String>): SystemPropertyConfigSource {
        val p = Properties()
        props.forEach { (k, v) -> p.setProperty(k, v) }
        return SystemPropertyConfigSource(propsProvider = { p })
    }

    @Test
    fun `has correct name and priority`() {
        val s = srcFrom(emptyMap())
        assertEquals("sysprop", s.name)
        assertEquals(ConfigPriority.SYSPROP, s.priority)
    }

    @Test
    fun `picks up furan dotted sysprops verbatim`() {
        val s = srcFrom(mapOf(
            "furan.apiUrl" to "https://x",
            "furan.retry.maxAttempts" to "5",
            "java.version" to "21",        // non-furan ignored
        ))
        val loaded = s.load()
        assertEquals("https://x", loaded["furan.apiUrl"])
        assertEquals("5", loaded["furan.retry.maxAttempts"])
        assertNull(loaded["java.version"])
        assertEquals(2, loaded.size)
    }

    @Test
    fun `the literal string null becomes a null value to support clears`() {
        val s = srcFrom(mapOf("furan.transport.proxy" to "null"))
        val loaded = s.load()
        assertEquals(null, loaded["furan.transport.proxy"])
        assertEquals(true, loaded.containsKey("furan.transport.proxy"))
    }
}
