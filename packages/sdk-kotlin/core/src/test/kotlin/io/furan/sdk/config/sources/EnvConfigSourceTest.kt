package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EnvConfigSourceTest {

    private fun envFromMap(map: Map<String, String>): EnvConfigSource =
        EnvConfigSource(
            lookup = { map[it] },
            enumerate = { map.keys },
        )

    @Test
    fun `has correct name and priority`() {
        val src = envFromMap(emptyMap())
        assertEquals("env", src.name)
        assertEquals(ConfigPriority.ENV, src.priority)
    }

    @Test
    fun `single underscore is path separator and double underscore is camelCase boundary`() {
        // Spring-style relaxed binding:
        //   FURAN_API__URL                       → furan.apiUrl
        //   FURAN_RETRY_MAX__ATTEMPTS            → furan.retry.maxAttempts
        //   FURAN_TRANSPORT_GZIP                 → furan.transport.gzip
        val src = envFromMap(mapOf(
            "FURAN_API__URL" to "https://x",
            "FURAN_API__TOKEN" to "tok",
            "FURAN_RETRY_MAX__ATTEMPTS" to "5",
            "FURAN_TRANSPORT_GZIP" to "true",
        ))
        val loaded = src.load()
        assertEquals("https://x", loaded["furan.apiUrl"])
        assertEquals("tok", loaded["furan.apiToken"])
        assertEquals("5", loaded["furan.retry.maxAttempts"])
        assertEquals("true", loaded["furan.transport.gzip"])
    }

    @Test
    fun `multi-level paths split on every single underscore`() {
        val src = envFromMap(mapOf("FURAN_OBSERVABILITY_TRACING_ENABLED" to "true"))
        val loaded = src.load()
        assertEquals("true", loaded["furan.observability.tracing.enabled"])
    }

    @Test
    fun `ignores vars not prefixed with FURAN_`() {
        val src = envFromMap(mapOf(
            "PATH" to "/usr/bin",
            "JAVA_HOME" to "/jdk",
            "FURAN_API__URL" to "https://x",
        ))
        val loaded = src.load()
        assertEquals(1, loaded.size)
        assertTrue(loaded.containsKey("furan.apiUrl"))
    }

    @Test
    fun `empty value produces empty string not null`() {
        // null means "key not set"; empty string means "set to empty".
        val src = envFromMap(mapOf("FURAN_API__URL" to ""))
        val loaded = src.load()
        assertEquals("", loaded["furan.apiUrl"])
    }

    @Test
    fun `triple plus camelCase tokens compose correctly`() {
        // FURAN_TRANSPORT_TLS_CLIENT__CERT → furan.transport.tls.clientCert
        val src = envFromMap(mapOf("FURAN_TRANSPORT_TLS_CLIENT__CERT" to "/etc/c"))
        val loaded = src.load()
        assertEquals("/etc/c", loaded["furan.transport.tls.clientCert"])
    }
}
