package io.furan.sdk.endpoint

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.time.Duration.Companion.minutes

class EndpointPrimitivesTest {

    @Test
    fun `EndpointHint defaults to no-region, no-tenant, default service`() {
        val hint = EndpointHint()
        assertEquals(null, hint.region)
        assertEquals(null, hint.tenantId)
        assertEquals("default", hint.service)
    }

    @Test
    fun `EndpointHint carries region, tenant, service`() {
        val hint = EndpointHint(region = "eu-west-1", tenantId = "acme", service = "snapshot")
        assertEquals("eu-west-1", hint.region)
        assertEquals("acme", hint.tenantId)
        assertEquals("snapshot", hint.service)
    }

    @Test
    fun `ResolvedEndpoint primary required fallbacks default empty ttl default 5m`() {
        val r = ResolvedEndpoint(primary = "https://x.example.com", source = "static")
        assertEquals("https://x.example.com", r.primary)
        assertEquals(emptyList<String>(), r.fallbacks)
        assertEquals(5.minutes, r.ttl)
        assertEquals("static", r.source)
    }

    @Test
    fun `ResolvedEndpoint structural equality`() {
        val a = ResolvedEndpoint(
            primary = "https://x.example.com",
            fallbacks = listOf("https://y.example.com"),
            ttl = 5.minutes,
            source = "static",
        )
        val b = ResolvedEndpoint(
            primary = "https://x.example.com",
            fallbacks = listOf("https://y.example.com"),
            ttl = 5.minutes,
            source = "static",
        )
        assertEquals(a, b)
        assertTrue(a !== b)
    }
}
