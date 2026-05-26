package io.furan.sdk.endpoint

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.runtime.FuranBootstrapper
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.time.ExperimentalTime
import kotlin.time.TestTimeSource
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalTime::class)
class Phase3EndToEndTest {

    @Test
    fun `bootstrap + drive a primary failure + see failover + recovery cycle`() = runTest {
        // Bootstrap into a runtime with a 3-endpoint Failover chain.
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            endpointConfig = EndpointResolutionConfig(
                primary = "https://primary.example.com",
                fallbacks = listOf("https://fb1.example.com", "https://fb2.example.com"),
                failoverDemoteWindow = 30.seconds,
            ),
        ).bootstrap()

        val resolver = rt.endpointResolver
        assertNotNull(resolver)
        assertTrue(resolver is FailoverEndpointResolver)

        // Happy path: primary is returned.
        val r1 = resolver!!.resolve()
        assertEquals("https://primary.example.com", r1.primary)

        // Simulate the future transport observing a 5xx on the primary.
        (resolver as FailoverEndpointResolver).markFailed("https://primary.example.com")

        // Next resolve: first fallback promoted.
        val r2 = resolver.resolve()
        assertEquals("https://fb1.example.com", r2.primary)
        assertEquals(listOf("https://fb2.example.com"), r2.fallbacks)
        assertEquals("failover[static]", r2.source)

        // Simulate the first fallback also failing.
        resolver.markFailed("https://fb1.example.com")
        val r3 = resolver.resolve()
        assertEquals("https://fb2.example.com", r3.primary)
        assertEquals(emptyList<String>(), r3.fallbacks)

        rt.close()
    }

    @Test
    fun `demote window expiry recovers a previously failed primary`() = runTest {
        val time = TestTimeSource()
        val inner = StaticEndpointResolver(primary = "https://p", fallbacks = listOf("https://f1"))
        val resolver = FailoverEndpointResolver(
            inner = inner,
            demoteWindow = 30.seconds,
            timeSource = time,
        )

        resolver.markFailed("https://p")
        assertEquals("https://f1", resolver.resolve().primary)

        time += 31.seconds
        // Primary should recover after the window elapses.
        assertEquals("https://p", resolver.resolve().primary)
    }

    @Test
    fun `all-demoted state returns inner primary as last-resort with empty fallbacks`() = runTest {
        val resolver = FailoverEndpointResolver(
            inner = StaticEndpointResolver(primary = "https://p", fallbacks = listOf("https://f1")),
        )
        resolver.markFailed("https://p")
        resolver.markFailed("https://f1")

        val r = resolver.resolve()
        // Caller can detect "all-demoted" by noticing that the returned
        // primary is in their own failed-list — it's a deliberate
        // last-resort path, not an exception.
        assertEquals("https://p", r.primary)
        assertEquals(emptyList<String>(), r.fallbacks)
    }
}
