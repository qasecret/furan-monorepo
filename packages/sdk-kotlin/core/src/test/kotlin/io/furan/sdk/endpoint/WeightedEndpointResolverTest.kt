package io.furan.sdk.endpoint

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class WeightedEndpointResolverTest {

    @Test
    fun `returns the only candidate when the list has one entry`() = runTest {
        val r = WeightedEndpointResolver(
            candidates = listOf(WeightedEndpoint("https://only", weight = 1)),
        )
        val resolved = r.resolve()
        assertEquals("https://only", resolved.primary)
        assertEquals("weighted", resolved.source)
    }

    @Test
    fun `weighted random pick — deterministic with injected Random`() = runTest {
        // Three candidates with weights 1, 2, 7 (total = 10).
        val r = WeightedEndpointResolver(
            candidates = listOf(
                WeightedEndpoint("https://a", weight = 1),
                WeightedEndpoint("https://b", weight = 2),
                WeightedEndpoint("https://c", weight = 7),
            ),
            random = Random(seed = 42),
        )
        val results = (1..1000).map { r.resolve().primary }
        val countA = results.count { it == "https://a" }
        val countB = results.count { it == "https://b" }
        val countC = results.count { it == "https://c" }
        // Expect roughly 100, 200, 700; allow ±50 slack for sampling.
        assertTrue(countA in 50..150, "countA = $countA")
        assertTrue(countB in 150..250, "countB = $countB")
        assertTrue(countC in 650..750, "countC = $countC")
    }

    @Test
    fun `same seed produces the same sequence (deterministic)`() = runTest {
        val candidates = listOf(
            WeightedEndpoint("https://a", weight = 1),
            WeightedEndpoint("https://b", weight = 1),
            WeightedEndpoint("https://c", weight = 1),
        )
        val r1 = WeightedEndpointResolver(candidates, random = Random(seed = 7))
        val r2 = WeightedEndpointResolver(candidates, random = Random(seed = 7))
        val seq1 = (1..20).map { r1.resolve().primary }
        val seq2 = (1..20).map { r2.resolve().primary }
        assertEquals(seq1, seq2)
    }

    @Test
    fun `rejects empty candidate list at construction`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            WeightedEndpointResolver(candidates = emptyList())
        }
        assertEquals("WeightedEndpointResolver.candidates must not be empty", ex.message)
    }

    @Test
    fun `source field is consistently weighted`() = runTest {
        val r = WeightedEndpointResolver(
            candidates = listOf(WeightedEndpoint("https://x", weight = 1)),
        )
        repeat(10) {
            assertEquals("weighted", r.resolve().source)
        }
    }
}
