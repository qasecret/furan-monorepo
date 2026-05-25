package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DefaultsConfigSourceTest {

    @Test
    fun `has correct name and priority`() {
        val s = DefaultsConfigSource()
        assertEquals("defaults", s.name)
        assertEquals(ConfigPriority.DEFAULTS, s.priority)
    }

    @Test
    fun `provides sensible defaults for retry transport and observability`() {
        val loaded = DefaultsConfigSource().load()
        assertEquals(3, loaded["furan.retry.maxAttempts"])
        assertEquals(true, loaded["furan.retry.enabled"])
        assertEquals(true, loaded["furan.transport.gzip"])
        assertEquals(64, loaded["furan.transport.maxConnections"])
        assertEquals(true, loaded["furan.observability.logEffectiveConfig"])
        assertEquals(false, loaded["furan.observability.debug"])
    }

    @Test
    fun `caller can override defaults via constructor`() {
        val custom = DefaultsConfigSource(overrides = mapOf("furan.retry.maxAttempts" to 5))
        val loaded = custom.load()
        assertEquals(5, loaded["furan.retry.maxAttempts"])
        assertTrue(loaded.containsKey("furan.transport.gzip"))   // still has built-ins
    }
}
