package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import kotlin.time.Duration.Companion.seconds
import kotlin.time.ExperimentalTime
import kotlin.time.TestTimeSource

@OptIn(ExperimentalTime::class)
class FailoverEndpointResolverTest {

    private fun inner(primary: String, vararg fallbacks: String): EndpointResolver =
        StaticEndpointResolver(primary = primary, fallbacks = fallbacks.toList())

    @Test
    fun `delegates to inner when no failures recorded`() = runTest {
        val f = FailoverEndpointResolver(
            inner = inner("https://p", "https://f1", "https://f2"),
        )
        val r = f.resolve()
        assertEquals("https://p", r.primary)
        assertEquals(listOf("https://f1", "https://f2"), r.fallbacks)
        assertEquals("failover[static]", r.source)
    }

    @Test
    fun `markFailed on the primary promotes the first non-failed fallback`() = runTest {
        val f = FailoverEndpointResolver(
            inner = inner("https://p", "https://f1", "https://f2"),
        )
        f.markFailed("https://p")
        val r = f.resolve()
        assertEquals("https://f1", r.primary)
        assertEquals(listOf("https://f2"), r.fallbacks)
    }

    @Test
    fun `markFailed on every endpoint falls back to the inner primary as last resort`() = runTest {
        val f = FailoverEndpointResolver(
            inner = inner("https://p", "https://f1"),
        )
        f.markFailed("https://p")
        f.markFailed("https://f1")
        val r = f.resolve()
        // All known endpoints are demoted; resolver returns the inner primary
        // with empty fallbacks rather than throwing — caller-friendly default.
        assertEquals("https://p", r.primary)
        assertEquals(emptyList<String>(), r.fallbacks)
    }

    @Test
    fun `demotion expires after demoteWindow and the primary recovers`() = runTest {
        val time = TestTimeSource()
        val f = FailoverEndpointResolver(
            inner = inner("https://p", "https://f1"),
            demoteWindow = 30.seconds,
            timeSource = time,
        )
        f.markFailed("https://p")
        assertEquals("https://f1", f.resolve().primary)
        time += 29.seconds
        assertEquals("https://f1", f.resolve().primary)  // still demoted
        time += 2.seconds                                 // total 31s > 30s window
        assertEquals("https://p", f.resolve().primary)   // recovered
    }

    @Test
    fun `markFailed on an unknown URL is a no-op`() = runTest {
        val f = FailoverEndpointResolver(
            inner = inner("https://p", "https://f1"),
        )
        // Caller may have stale URL — silently ignore rather than throw.
        f.markFailed("https://unknown-host.example.com")
        assertEquals("https://p", f.resolve().primary)
    }
}
