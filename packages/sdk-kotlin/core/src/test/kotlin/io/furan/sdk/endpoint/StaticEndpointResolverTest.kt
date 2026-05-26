package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

class StaticEndpointResolverTest {

    @Test
    fun `returns the configured primary regardless of hint`() = runTest {
        val r = StaticEndpointResolver(primary = "https://api.example.com")
        val rA = r.resolve(EndpointHint(region = "eu"))
        val rB = r.resolve(EndpointHint(region = "us"))
        assertEquals("https://api.example.com", rA.primary)
        assertEquals("https://api.example.com", rB.primary)
        assertEquals("static", rA.source)
    }

    @Test
    fun `carries configured fallbacks and ttl`() = runTest {
        val r = StaticEndpointResolver(
            primary = "https://primary.example.com",
            fallbacks = listOf("https://fallback1.example.com", "https://fallback2.example.com"),
            ttl = 30.minutes,
        )
        val resolved = r.resolve()
        assertEquals(listOf("https://fallback1.example.com", "https://fallback2.example.com"), resolved.fallbacks)
        assertEquals(30.minutes, resolved.ttl)
    }

    @Test
    fun `empty primary URL fails fast at construction`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            StaticEndpointResolver(primary = "")
        }
        assertEquals("StaticEndpointResolver.primary must not be blank", ex.message)
    }

    @Test
    fun `ttl below 1 second fails fast at construction`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            StaticEndpointResolver(primary = "https://x", ttl = Duration.ZERO)
        }
        assertEquals("StaticEndpointResolver.ttl must be > 0", ex.message)
    }
}
