package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ConfigMergeTest {

    @Test
    fun `scalar in higher layer overrides lower`() {
        val low = mapOf("furan.endpoint" to "https://low")
        val high = mapOf("furan.endpoint" to "https://high")
        val merged = ConfigMerge.deepMerge(low, high)
        assertEquals("https://high", merged["furan.endpoint"])
    }

    @Test
    fun `key absent in higher layer falls back to lower`() {
        val low = mapOf("furan.endpoint" to "https://low", "furan.project" to "p")
        val high = mapOf("furan.endpoint" to "https://high")
        val merged = ConfigMerge.deepMerge(low, high)
        assertEquals("https://high", merged["furan.endpoint"])
        assertEquals("p", merged["furan.project"])
    }

    @Test
    fun `explicit null in higher layer clears lower (Kubernetes-style)`() {
        val low = mapOf("furan.transport.proxy" to "http://corp:3128")
        val high = mapOf("furan.transport.proxy" to null)
        val merged = ConfigMerge.deepMerge(low, high)
        assertTrue(merged.containsKey("furan.transport.proxy"))
        assertNull(merged["furan.transport.proxy"])
    }

    @Test
    fun `nested map in higher layer replaces wholesale by default`() {
        // No `inherit: true` directive → higher map REPLACES lower map.
        val low = mapOf(
            "furan.retry" to mapOf("maxAttempts" to 3, "initialBackoff" to "250ms"),
        )
        val high = mapOf(
            "furan.retry" to mapOf("maxAttempts" to 5),  // no `inherit`
        )
        val merged = ConfigMerge.deepMerge(low, high)
        val retry = merged["furan.retry"] as Map<*, *>
        assertEquals(5, retry["maxAttempts"])
        assertEquals(null, retry["initialBackoff"])  // wiped, no inherit
        assertEquals(1, retry.size)
    }

    @Test
    fun `nested map with inherit true deep-merges`() {
        val low = mapOf(
            "furan.retry" to mapOf("maxAttempts" to 3, "initialBackoff" to "250ms"),
        )
        val high = mapOf(
            "furan.retry" to mapOf("inherit" to true, "maxAttempts" to 5),
        )
        val merged = ConfigMerge.deepMerge(low, high)
        val retry = merged["furan.retry"] as Map<*, *>
        assertEquals(5, retry["maxAttempts"])
        assertEquals("250ms", retry["initialBackoff"])
        assertEquals(false, retry.containsKey("inherit"))  // directive consumed
    }

    @Test
    fun `list in higher layer replaces lower (no concatenation)`() {
        val low = mapOf("furan.viewports" to listOf(1, 2, 3))
        val high = mapOf("furan.viewports" to listOf(4))
        val merged = ConfigMerge.deepMerge(low, high)
        assertEquals(listOf(4), merged["furan.viewports"])
    }

    @Test
    fun `inherit true at nested level is recursive`() {
        val low = mapOf(
            "furan.transport" to mapOf(
                "gzip" to true,
                "tls" to mapOf("strict" to true, "trustStore" to "/etc/ts"),
            ),
        )
        val high = mapOf(
            "furan.transport" to mapOf(
                "inherit" to true,
                "tls" to mapOf("inherit" to true, "strict" to false),
            ),
        )
        val merged = ConfigMerge.deepMerge(low, high)
        @Suppress("UNCHECKED_CAST")
        val transport = merged["furan.transport"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val tls = transport["tls"] as Map<String, Any?>
        assertEquals(true, transport["gzip"])
        assertEquals(false, tls["strict"])
        assertEquals("/etc/ts", tls["trustStore"])
    }

    @Test
    fun `empty layers compose to empty map`() {
        assertEquals(emptyMap<String, Any?>(), ConfigMerge.deepMerge(emptyMap(), emptyMap()))
    }

    @Test
    fun `mergeAll applies layers in order (low to high)`() {
        val defaults = mapOf("furan.project" to "default-proj", "furan.endpoint" to "https://default")
        val yaml = mapOf("furan.project" to "yaml-proj")
        val env = mapOf("furan.endpoint" to "https://env")
        val merged = ConfigMerge.mergeAll(listOf(defaults, yaml, env))
        assertEquals("yaml-proj", merged["furan.project"])
        assertEquals("https://env", merged["furan.endpoint"])
    }
}
