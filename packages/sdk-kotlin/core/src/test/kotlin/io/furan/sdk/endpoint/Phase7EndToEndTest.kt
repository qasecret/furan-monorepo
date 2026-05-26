package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class Phase7EndToEndTest {

    @Test
    fun `production stack — Failover wrapping Canary wrapping Weighted`() = runTest {
        // Weighted base: 70% US, 30% EU.
        val stableBase = WeightedEndpointResolver(
            candidates = listOf(
                WeightedEndpoint("https://stable-us.example.com", weight = 7),
                WeightedEndpoint("https://stable-eu.example.com", weight = 3),
            ),
            random = Random(seed = 1),
        )
        val canaryBase = StaticEndpointResolver(primary = "https://canary.example.com")

        // 5% canary rollout, sticky by tenantId.
        val canary = CanaryEndpointResolver(
            stable = stableBase,
            canary = canaryBase,
            canaryFraction = 0.05,
            stickyBy = { it.tenantId },
            random = Random(seed = 2),
        )

        // Failover wraps the lot — if any endpoint reports failure,
        // it's demoted for the window.
        val resolver = FailoverEndpointResolver(inner = canary)

        // 200 distinct tenants → most go to stable (which itself
        // weighted-splits US/EU); a small slice goes to canary.
        val results = (1..200).map { i ->
            resolver.resolve(EndpointHint(tenantId = "tenant-$i"))
        }
        val canaryHits = results.count { it.primary == "https://canary.example.com" }
        // Expect ~10 canary hits out of 200 (5%); allow generous slack.
        assertTrue(canaryHits in 0..30, "canaryHits = $canaryHits")

        // Source string composes through the chain: failover[canary[static]] or failover[canary[weighted]].
        val firstSource = results[0].source
        assertTrue(firstSource.startsWith("failover[canary["), "source: $firstSource")
    }

    @Test
    fun `TenantAffinityResolver gives stable per-tenant shard routing`() = runTest {
        val shardA = StaticEndpointResolver(primary = "https://shard-a.example.com")
        val shardB = StaticEndpointResolver(primary = "https://shard-b.example.com")
        val shardC = StaticEndpointResolver(primary = "https://shard-c.example.com")

        val resolver = TenantAffinityResolver(pool = listOf(shardA, shardB, shardC))

        // Same tenant always lands on the same shard.
        val acmeDecisions = (1..30).map { resolver.resolve(EndpointHint(tenantId = "acme")).primary }.toSet()
        assertEquals(1, acmeDecisions.size, "acme decisions: $acmeDecisions")

        // 50 distinct tenants → distribution across the pool.
        val distinctShards = (1..50).map { i ->
            resolver.resolve(EndpointHint(tenantId = "tenant-$i")).primary
        }.toSet()
        assertTrue(distinctShards.size >= 2, "expected >= 2 shards seen, got $distinctShards")

        // null tenantId → default branch (first by default).
        assertEquals("https://shard-a.example.com",
            resolver.resolve(EndpointHint(tenantId = null)).primary)
    }
}
