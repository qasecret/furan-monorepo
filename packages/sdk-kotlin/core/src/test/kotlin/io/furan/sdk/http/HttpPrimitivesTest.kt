package io.furan.sdk.http

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HttpPrimitivesTest {

    @Test
    fun `HttpMethod has all standard verbs`() {
        val methods = HttpMethod.values().toSet()
        assertEquals(
            setOf(
                HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT,
                HttpMethod.DELETE, HttpMethod.PATCH, HttpMethod.HEAD,
            ),
            methods,
        )
    }

    @Test
    fun `HttpRequest carries method, url, headers, and optional body`() {
        val req = HttpRequest(
            method = HttpMethod.POST,
            url = "https://api.example.com/runs",
            headers = mapOf("X-Request-Id" to "abc-123"),
            body = null,
        )
        assertEquals(HttpMethod.POST, req.method)
        assertEquals("https://api.example.com/runs", req.url)
        assertEquals("abc-123", req.headers["X-Request-Id"])
        assertEquals(null, req.body)
    }

    @Test
    fun `HttpRequest defaults headers to empty and body to null`() {
        val req = HttpRequest(method = HttpMethod.GET, url = "https://x")
        assertEquals(emptyMap<String, String>(), req.headers)
        assertEquals(null, req.body)
    }

    @Test
    fun `HttpRequest rejects blank url at construction`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException::class.java) {
            HttpRequest(method = HttpMethod.GET, url = "")
        }
        assertTrue(ex.message!!.contains("url"))
    }
}
