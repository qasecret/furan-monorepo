package io.furan.sdk.http

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class HttpTransportContractTest {

    private class FakeHttpTransport(
        private val canned: HttpResponse = HttpResponse(200, emptyMap(), "{}"),
    ) : HttpTransport {
        val seen = CopyOnWriteArrayList<HttpRequest>()
        val closed = AtomicBoolean(false)
        override suspend fun execute(request: HttpRequest): HttpResponse {
            seen += request
            return canned
        }
        override fun close() {
            closed.set(true)
        }
    }

    @Test
    fun `HttpTransport is a suspend-fun interface that takes HttpRequest and returns HttpResponse`() = runTest {
        val transport: HttpTransport = FakeHttpTransport(
            canned = HttpResponse(201, mapOf("Location" to "/runs/abc"), """{"id":"abc"}"""),
        )
        val req = HttpRequest(
            method = HttpMethod.POST,
            url = "https://api.example.com/runs",
            headers = mapOf("Authorization" to "Bearer xyz"),
            body = HttpBody.JsonString("""{"projectId":"p1"}"""),
        )
        val res = transport.execute(req)
        assertEquals(201, res.statusCode)
        assertEquals("/runs/abc", res.headers["Location"])
        assertTrue(res.body.contains("abc"))
    }

    @Test
    fun `HttpTransport implements AutoCloseable`() {
        val transport = FakeHttpTransport()
        val asCloseable: AutoCloseable = transport
        asCloseable.close()
        assertTrue(transport.closed.get())
    }
}
