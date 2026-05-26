package io.furan.sdk.http

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HttpResponseTest {

    @Test
    fun `HttpResponse carries status, headers, and body`() {
        val r = HttpResponse(
            statusCode = 200,
            headers = mapOf("Content-Type" to "application/json"),
            body = """{"ok":true}""",
        )
        assertEquals(200, r.statusCode)
        assertEquals("application/json", r.headers["Content-Type"])
        assertEquals("""{"ok":true}""", r.body)
    }

    @Test
    fun `isSuccess returns true for 200-299 only`() {
        assertTrue(HttpResponse(200, emptyMap(), "").isSuccess)
        assertTrue(HttpResponse(201, emptyMap(), "").isSuccess)
        assertTrue(HttpResponse(204, emptyMap(), "").isSuccess)
        assertTrue(HttpResponse(299, emptyMap(), "").isSuccess)
        assertFalse(HttpResponse(199, emptyMap(), "").isSuccess)
        assertFalse(HttpResponse(300, emptyMap(), "").isSuccess)
        assertFalse(HttpResponse(404, emptyMap(), "").isSuccess)
        assertFalse(HttpResponse(500, emptyMap(), "").isSuccess)
    }

    @Test
    fun `isRetriable returns true for 408, 429, and 5xx`() {
        assertTrue(HttpResponse(408, emptyMap(), "").isRetriable)
        assertTrue(HttpResponse(429, emptyMap(), "").isRetriable)
        assertTrue(HttpResponse(500, emptyMap(), "").isRetriable)
        assertTrue(HttpResponse(503, emptyMap(), "").isRetriable)
        assertTrue(HttpResponse(599, emptyMap(), "").isRetriable)
        assertFalse(HttpResponse(200, emptyMap(), "").isRetriable)
        assertFalse(HttpResponse(404, emptyMap(), "").isRetriable)
        assertFalse(HttpResponse(401, emptyMap(), "").isRetriable)
    }
}
