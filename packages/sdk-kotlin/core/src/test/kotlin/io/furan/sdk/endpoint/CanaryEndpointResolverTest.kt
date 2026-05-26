package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class CanaryEndpointResolverTest {

    private fun stable() = StaticEndpointResolver(primary = "https://stable.example.com")
    private fun canary() = StaticEndpointResolver(primary = "https://canary.example.com")

    @Test
    fun `canaryFraction=0 always returns stable`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 0.0,
        )
        repeat(20) {
            assertEquals("https://stable.example.com", r.resolve().primary)
        }
    }

    @Test
    fun `canaryFraction=1_0 always returns canary`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 1.0,
        )
        repeat(20) {
            assertEquals("https://canary.example.com", r.resolve().primary)
        }
    }

    @Test
    fun `canaryFraction=0_3 produces roughly 30 percent canary over many random calls`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 0.3,
            random = Random(seed = 42),
        )
        val results = (1..1000).map { r.resolve().primary }
        val canaryCount = results.count { it == "https://canary.example.com" }
        // Expect ~300, allow ±50 slack.
        assertTrue(canaryCount in 250..350, "canaryCount = $canaryCount")
    }

    @Test
    fun `sticky routing — same key always routes the same way regardless of canaryFraction`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 0.5,
            stickyBy = { hint -> hint.tenantId },
        )
        val tenant = "acme-corp"
        val decisions = (1..50).map {
            r.resolve(EndpointHint(tenantId = tenant)).primary
        }.toSet()
        assertEquals(1, decisions.size, "expected sticky routing, got $decisions")
    }

    @Test
    fun `sticky routing — different keys distribute according to canaryFraction`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 0.3,
            stickyBy = { hint -> hint.tenantId },
        )
        val canaryHits = (1..200).count { i ->
            r.resolve(EndpointHint(tenantId = "tenant-$i")).primary == "https://canary.example.com"
        }
        // Expect ~60, allow ±20 slack.
        assertTrue(canaryHits in 40..80, "canaryHits = $canaryHits")
    }

    @Test
    fun `null stickyBy result falls back to random selection`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 1.0,
            stickyBy = { hint -> hint.tenantId },
        )
        repeat(20) {
            assertEquals("https://canary.example.com", r.resolve().primary)
        }
    }

    @Test
    fun `source string wraps the inner resolver's source`() = runTest {
        val r = CanaryEndpointResolver(
            stable = stable(),
            canary = canary(),
            canaryFraction = 0.0,
        )
        assertEquals("canary[static]", r.resolve().source)
    }

    @Test
    fun `rejects canaryFraction outside 0_0 to 1_0`() {
        val low = assertThrows(IllegalArgumentException::class.java) {
            CanaryEndpointResolver(stable(), canary(), canaryFraction = -0.1)
        }
        assertTrue(low.message!!.contains("canaryFraction"))
        val high = assertThrows(IllegalArgumentException::class.java) {
            CanaryEndpointResolver(stable(), canary(), canaryFraction = 1.5)
        }
        assertTrue(high.message!!.contains("canaryFraction"))
    }
}
