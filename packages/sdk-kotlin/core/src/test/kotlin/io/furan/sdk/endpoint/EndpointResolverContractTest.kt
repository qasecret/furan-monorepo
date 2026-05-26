package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class EndpointResolverContractTest {

    @Test
    fun `EndpointResolver is a suspend fun interface that returns ResolvedEndpoint`() = runTest {
        val resolver = object : EndpointResolver {
            override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint =
                ResolvedEndpoint(primary = "https://${hint.region ?: "default"}.example.com", source = "fake")
        }

        val r1 = resolver.resolve(EndpointHint())
        assertEquals("https://default.example.com", r1.primary)
        assertEquals("fake", r1.source)

        val r2 = resolver.resolve(EndpointHint(region = "eu"))
        assertEquals("https://eu.example.com", r2.primary)
    }

    @Test
    fun `resolve has a default-hint overload`() = runTest {
        val resolver = object : EndpointResolver {
            override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint =
                ResolvedEndpoint(primary = "https://x", source = "fake")
        }
        // Calling without a hint argument uses the default EndpointHint().
        val r = resolver.resolve()
        assertEquals("https://x", r.primary)
    }
}
