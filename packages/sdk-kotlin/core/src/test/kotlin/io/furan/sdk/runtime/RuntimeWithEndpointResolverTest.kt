package io.furan.sdk.runtime

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.endpoint.EndpointResolutionConfig
import io.furan.sdk.endpoint.FailoverEndpointResolver
import io.furan.sdk.endpoint.StaticEndpointResolver
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RuntimeWithEndpointResolverTest {

    @Test
    fun `default bootstrap leaves runtime endpointResolver null`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        assertNull(rt.endpointResolver)
        rt.close()
    }

    @Test
    fun `bootstrap with endpointConfig primary builds a Static resolver wrapped in Failover by default`() = runTest {
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            endpointConfig = EndpointResolutionConfig(
                primary = "https://api.example.com",
                fallbacks = listOf("https://api-eu.example.com"),
            ),
        ).bootstrap()

        val resolver = rt.endpointResolver
        assertNotNull(resolver)
        assertTrue(resolver is FailoverEndpointResolver)

        val resolved = resolver!!.resolve()
        assertEquals("https://api.example.com", resolved.primary)
        assertEquals(listOf("https://api-eu.example.com"), resolved.fallbacks)
        rt.close()
    }

    @Test
    fun `failoverEnabled=false skips the Failover decorator and returns the Static resolver directly`() = runTest {
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            endpointConfig = EndpointResolutionConfig(
                primary = "https://api.example.com",
                failoverEnabled = false,
            ),
        ).bootstrap()

        val resolver = rt.endpointResolver
        assertNotNull(resolver)
        assertTrue(resolver is StaticEndpointResolver)
        rt.close()
    }

    @Test
    fun `runtime constructed directly with a resolver exposes it`() = runTest {
        val resolver = StaticEndpointResolver(primary = "https://x")
        val bus = io.furan.sdk.event.SharedFlowEventBus()
        val rt = FuranRuntime(
            config = io.furan.sdk.config.DefaultConfigRegistry(emptyMap()),
            eventBus = bus,
            stateMachine = StateMachine(bus),
            endpointResolver = resolver,
        )
        assertEquals(resolver, rt.endpointResolver)
        rt.close()
    }
}
