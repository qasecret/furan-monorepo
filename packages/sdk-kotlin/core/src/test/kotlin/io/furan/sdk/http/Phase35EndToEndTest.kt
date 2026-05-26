package io.furan.sdk.http

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.runtime.FuranBootstrapper
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class Phase35EndToEndTest {

    @Test
    fun `bootstrap with KtorHttpTransport allows executing requests through the runtime`() = runTest {
        val mockEngine = MockEngine { request ->
            when (request.url.encodedPath) {
                "/runs" -> respond("""{"id":"run-1"}""", HttpStatusCode.Created)
                "/health" -> respond("""{"ok":true}""", HttpStatusCode.OK)
                else -> respond("not found", HttpStatusCode.NotFound)
            }
        }

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            httpTransportFactory = { KtorHttpTransport(engine = mockEngine) },
        ).bootstrap()

        val transport = rt.httpTransport
        assertNotNull(transport)

        // 1. Health-check GET succeeds.
        val healthRes = transport!!.execute(HttpRequest(HttpMethod.GET, "https://api.example.com/health"))
        assertEquals(200, healthRes.statusCode)
        assertTrue(healthRes.body.contains("ok"))
        assertTrue(healthRes.isSuccess)

        // 2. Create-run POST with JSON body returns 201.
        val createRes = transport.execute(HttpRequest(
            method = HttpMethod.POST,
            url = "https://api.example.com/runs",
            body = HttpBody.JsonString("""{"projectId":"p1"}"""),
        ))
        assertEquals(201, createRes.statusCode)
        assertTrue(createRes.body.contains("run-1"))

        // 3. Unknown path returns 404, NOT thrown, and `isRetriable` is false.
        val unknownRes = transport.execute(HttpRequest(HttpMethod.GET, "https://api.example.com/nope"))
        assertEquals(404, unknownRes.statusCode)
        assertEquals(false, unknownRes.isSuccess)
        assertEquals(false, unknownRes.isRetriable)

        rt.close()
    }

    @Test
    fun `transport is closed when the runtime closes`() = runTest {
        var closeCount = 0
        val mockEngine = MockEngine { respond("{}", HttpStatusCode.OK) }
        val wrappingTransport = object : HttpTransport {
            private val delegate = KtorHttpTransport(engine = mockEngine)
            override suspend fun execute(request: HttpRequest) = delegate.execute(request)
            override fun close() {
                closeCount++
                delegate.close()
            }
        }

        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            httpTransportFactory = { wrappingTransport },
        ).bootstrap()

        // Trigger one call so the transport is exercised.
        rt.httpTransport!!.execute(HttpRequest(HttpMethod.GET, "https://x"))

        rt.close()
        assertEquals(1, closeCount, "expected runtime.close to call transport.close exactly once")

        // Idempotent — closing runtime twice doesn't double-close transport.
        rt.close()
        assertEquals(1, closeCount, "expected idempotent runtime.close")
    }
}
