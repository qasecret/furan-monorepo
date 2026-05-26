package io.furan.sdk.endpoint

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class EndpointResolutionConfigTest {

    @Test
    fun `default config has no primary and no fallbacks`() {
        val c = EndpointResolutionConfig()
        assertEquals(null, c.primary)
        assertEquals(emptyList<String>(), c.fallbacks)
        assertEquals(5.minutes, c.ttl)
        assertTrue(c.failoverEnabled)
        assertEquals(30.seconds, c.failoverDemoteWindow)
    }

    @Test
    fun `custom primary + fallbacks + failoverEnabled=false`() {
        val c = EndpointResolutionConfig(
            primary = "https://api.example.com",
            fallbacks = listOf("https://api-eu.example.com"),
            failoverEnabled = false,
        )
        assertEquals("https://api.example.com", c.primary)
        assertEquals(listOf("https://api-eu.example.com"), c.fallbacks)
        assertEquals(false, c.failoverEnabled)
    }

    @Test
    fun `failoverDemoteWindow must be positive`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            EndpointResolutionConfig(
                primary = "https://x",
                failoverDemoteWindow = kotlin.time.Duration.ZERO,
            )
        }
        assertEquals("EndpointResolutionConfig.failoverDemoteWindow must be > 0", ex.message)
    }

    @Test
    fun `ttl must be positive`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            EndpointResolutionConfig(
                primary = "https://x",
                ttl = kotlin.time.Duration.ZERO,
            )
        }
        assertEquals("EndpointResolutionConfig.ttl must be > 0", ex.message)
    }
}
