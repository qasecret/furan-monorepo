package io.furan.sdk.plugin

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CapabilityRegistryTest {

    @Test
    fun `empty registry has no capabilities`() {
        val r = DefaultCapabilityRegistry()
        assertFalse(r.has(Capability.Tracing))
        assertEquals(emptyList<String>(), r.providers(Capability.Tracing))
        assertEquals(emptyMap<Capability, List<String>>(), r.all())
    }

    @Test
    fun `advertise records the provider and makes has return true`() {
        val r = DefaultCapabilityRegistry()
        r.advertise(Capability.Tracing, "furan-otel")
        assertTrue(r.has(Capability.Tracing))
        assertEquals(listOf("furan-otel"), r.providers(Capability.Tracing))
    }

    @Test
    fun `multiple providers for the same capability all appear in order of advertise`() {
        val r = DefaultCapabilityRegistry()
        r.advertise(Capability.Metrics, "furan-otel")
        r.advertise(Capability.Metrics, "furan-micrometer")
        assertEquals(listOf("furan-otel", "furan-micrometer"), r.providers(Capability.Metrics))
    }

    @Test
    fun `advertise is idempotent — same provider does not double-register`() {
        val r = DefaultCapabilityRegistry()
        r.advertise(Capability.Tracing, "furan-otel")
        r.advertise(Capability.Tracing, "furan-otel")
        assertEquals(listOf("furan-otel"), r.providers(Capability.Tracing))
    }

    @Test
    fun `all returns every advertised capability mapped to its providers`() {
        val r = DefaultCapabilityRegistry()
        r.advertise(Capability.Tracing, "furan-otel")
        r.advertise(Capability.Metrics, "furan-otel")
        r.advertise(Capability.VaultSupport, "furan-vault")

        val snapshot = r.all()
        assertEquals(3, snapshot.size)
        assertEquals(listOf("furan-otel"), snapshot[Capability.Tracing])
        assertEquals(listOf("furan-otel"), snapshot[Capability.Metrics])
        assertEquals(listOf("furan-vault"), snapshot[Capability.VaultSupport])
    }

    @Test
    fun `custom capabilities are tracked separately from built-ins with the same key`() {
        val r = DefaultCapabilityRegistry()
        r.advertise(Capability.Tracing, "builtin-provider")
        r.advertise(Capability.Custom("tracing"), "custom-provider")
        assertTrue(r.has(Capability.Tracing))
        assertTrue(r.has(Capability.Custom("tracing")))
        assertEquals(listOf("builtin-provider"), r.providers(Capability.Tracing))
        assertEquals(listOf("custom-provider"), r.providers(Capability.Custom("tracing")))
    }
}
