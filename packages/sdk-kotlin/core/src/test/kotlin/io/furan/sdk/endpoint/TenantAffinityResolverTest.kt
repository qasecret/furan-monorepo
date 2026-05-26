package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TenantAffinityResolverTest {

    private fun staticAt(url: String) = StaticEndpointResolver(primary = url)

    @Test
    fun `same tenantId always routes to the same branch`() = runTest {
        val r = TenantAffinityResolver(
            pool = listOf(
                staticAt("https://shard-a.example.com"),
                staticAt("https://shard-b.example.com"),
                staticAt("https://shard-c.example.com"),
            ),
        )
        val tenant = "acme-corp"
        val decisions = (1..50).map {
            r.resolve(EndpointHint(tenantId = tenant)).primary
        }.toSet()
        assertEquals(1, decisions.size, "expected one consistent shard for tenant '$tenant'; got $decisions")
    }

    @Test
    fun `different tenants distribute across the pool`() = runTest {
        val r = TenantAffinityResolver(
            pool = listOf(
                staticAt("https://shard-a.example.com"),
                staticAt("https://shard-b.example.com"),
                staticAt("https://shard-c.example.com"),
            ),
        )
        val urls = (1..100).map { i ->
            r.resolve(EndpointHint(tenantId = "tenant-$i")).primary
        }
        // At least 2 distinct shards seen across 100 tenants.
        val distinct = urls.toSet()
        assertTrue(distinct.size >= 2, "expected distribution across pool; got distinct = $distinct")
    }

    @Test
    fun `null tenantId routes to the default branch (first by default)`() = runTest {
        val r = TenantAffinityResolver(
            pool = listOf(
                staticAt("https://default.example.com"),
                staticAt("https://shard-b.example.com"),
            ),
        )
        val resolved = r.resolve(EndpointHint(tenantId = null))
        assertEquals("https://default.example.com", resolved.primary)
    }

    @Test
    fun `null tenantId can route to a custom default branch`() = runTest {
        val customDefault = staticAt("https://custom-default.example.com")
        val r = TenantAffinityResolver(
            pool = listOf(
                staticAt("https://shard-a.example.com"),
                staticAt("https://shard-b.example.com"),
            ),
            defaultBranch = customDefault,
        )
        val resolved = r.resolve(EndpointHint(tenantId = null))
        assertEquals("https://custom-default.example.com", resolved.primary)
    }

    @Test
    fun `source string wraps the inner resolver's source`() = runTest {
        val r = TenantAffinityResolver(
            pool = listOf(staticAt("https://shard.example.com")),
        )
        val resolved = r.resolve(EndpointHint(tenantId = "acme"))
        assertEquals("tenant[static]", resolved.source)
    }

    @Test
    fun `rejects empty pool at construction`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            TenantAffinityResolver(pool = emptyList())
        }
        assertEquals("TenantAffinityResolver.pool must not be empty", ex.message)
    }
}
