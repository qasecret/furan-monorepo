package io.furan.sdk.plugin

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class CapabilityTest {

    @Test
    fun `built-in capabilities have stable string keys`() {
        assertEquals("tracing", Capability.Tracing.key)
        assertEquals("metrics", Capability.Metrics.key)
        assertEquals("offline-buffer", Capability.OfflineBuffering.key)
        assertEquals("spring-runtime", Capability.SpringRuntime.key)
        assertEquals("vault", Capability.VaultSupport.key)
        assertEquals("mtls", Capability.MTls.key)
        assertEquals("region-aware", Capability.RegionAware.key)
        assertEquals("circuit-breaker", Capability.CircuitBreaker.key)
    }

    @Test
    fun `built-in capabilities are singletons (object instances)`() {
        val a: Capability = Capability.Tracing
        val b: Capability = Capability.Tracing
        assertEquals(a, b)
        assertEquals(System.identityHashCode(a), System.identityHashCode(b))
    }

    @Test
    fun `Custom capability carries an arbitrary key`() {
        val a = Capability.Custom("my-feature")
        val b = Capability.Custom("my-feature")
        val c = Capability.Custom("other-feature")
        assertEquals("my-feature", a.key)
        assertEquals(a, b)
        assertNotEquals(a, c)
    }

    @Test
    fun `Custom and built-in with same key are NOT equal`() {
        val custom = Capability.Custom("tracing")
        val builtin: Capability = Capability.Tracing
        assertNotEquals(custom, builtin)
    }
}
