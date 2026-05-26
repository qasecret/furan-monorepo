package io.furan.sdk.http

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KtorHttpTransportTest {

    @Test
    fun `GET request is dispatched and 200 response is decoded`() = runTest {
        val mockEngine = MockEngine { request ->
            assertEquals("https://api.example.com/health", request.url.toString())
            respond(
                content = """{"status":"ok"}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val transport = KtorHttpTransport(engine = mockEngine)
        val res = transport.execute(HttpRequest(HttpMethod.GET, "https://api.example.com/health"))
        assertEquals(200, res.statusCode)
        assertEquals("""{"status":"ok"}""", res.body)
        assertTrue(res.isSuccess)
        transport.close()
    }

    @Test
    fun `POST with JsonString body sends application-json content type`() = runTest {
        var capturedContentType: String? = null
        var capturedBody: String? = null
        val mockEngine = MockEngine { request ->
            // In Ktor 3.x, DefaultTransform removes Content-Type from headers
            // and places it on the OutgoingContent body. Read from body.contentType.
            capturedContentType = request.body.contentType?.toString()
            capturedBody = String(request.body.toByteArray())
            respond("{}", HttpStatusCode.Created)
        }
        val transport = KtorHttpTransport(engine = mockEngine)
        transport.execute(HttpRequest(
            method = HttpMethod.POST,
            url = "https://api.example.com/runs",
            body = HttpBody.JsonString("""{"projectId":"p1"}"""),
        ))
        assertTrue(capturedContentType!!.contains("application/json"))
        assertEquals("""{"projectId":"p1"}""", capturedBody)
        transport.close()
    }

    @Test
    fun `custom request headers are forwarded`() = runTest {
        var seenAuth: String? = null
        var seenReqId: String? = null
        val mockEngine = MockEngine { request ->
            seenAuth = request.headers["Authorization"]
            seenReqId = request.headers["X-Request-Id"]
            respond("", HttpStatusCode.OK)
        }
        val transport = KtorHttpTransport(engine = mockEngine)
        transport.execute(HttpRequest(
            method = HttpMethod.GET,
            url = "https://x",
            headers = mapOf(
                "Authorization" to "Bearer abc",
                "X-Request-Id" to "req-42",
            ),
        ))
        assertEquals("Bearer abc", seenAuth)
        assertEquals("req-42", seenReqId)
        transport.close()
    }

    @Test
    fun `non-2xx response returns successfully without throwing`() = runTest {
        val mockEngine = MockEngine { _ ->
            respond("""{"error":"not_found"}""", HttpStatusCode.NotFound)
        }
        val transport = KtorHttpTransport(engine = mockEngine)
        val res = transport.execute(HttpRequest(HttpMethod.GET, "https://x"))
        assertEquals(404, res.statusCode)
        assertEquals("""{"error":"not_found"}""", res.body)
        assertEquals(false, res.isSuccess)
        assertEquals(false, res.isRetriable)
        transport.close()
    }

    @Test
    fun `5xx response is flagged as retriable`() = runTest {
        val mockEngine = MockEngine { _ ->
            respond("upstream down", HttpStatusCode.BadGateway)
        }
        val transport = KtorHttpTransport(engine = mockEngine)
        val res = transport.execute(HttpRequest(HttpMethod.GET, "https://x"))
        assertEquals(502, res.statusCode)
        assertEquals(true, res.isRetriable)
        transport.close()
    }

    @Test
    fun `close releases the underlying Ktor client`() {
        val mockEngine = MockEngine { _ -> respond("", HttpStatusCode.OK) }
        val transport = KtorHttpTransport(engine = mockEngine)
        transport.close()
        // No exception on double-close.
        transport.close()
    }
}
