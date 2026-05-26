package io.furan.sdk.endpoint

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class WeightedEndpointTest {

    @Test
    fun `WeightedEndpoint carries url, weight, and tags`() {
        val e = WeightedEndpoint(
            url = "https://api-eu.example.com",
            weight = 5,
            tags = mapOf("region" to "eu", "version" to "v2"),
        )
        assertEquals("https://api-eu.example.com", e.url)
        assertEquals(5, e.weight)
        assertEquals("eu", e.tags["region"])
        assertEquals("v2", e.tags["version"])
    }

    @Test
    fun `WeightedEndpoint defaults tags to empty map`() {
        val e = WeightedEndpoint(url = "https://x", weight = 1)
        assertEquals(emptyMap<String, String>(), e.tags)
    }

    @Test
    fun `WeightedEndpoint rejects blank url at construction`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            WeightedEndpoint(url = "", weight = 1)
        }
        assertEquals("WeightedEndpoint.url must not be blank", ex.message)
    }

    @Test
    fun `WeightedEndpoint rejects zero or negative weight`() {
        val zero = assertThrows(IllegalArgumentException::class.java) {
            WeightedEndpoint(url = "https://x", weight = 0)
        }
        assertEquals("WeightedEndpoint.weight must be > 0 (got 0)", zero.message)
        val neg = assertThrows(IllegalArgumentException::class.java) {
            WeightedEndpoint(url = "https://x", weight = -3)
        }
        assertEquals("WeightedEndpoint.weight must be > 0 (got -3)", neg.message)
    }
}
