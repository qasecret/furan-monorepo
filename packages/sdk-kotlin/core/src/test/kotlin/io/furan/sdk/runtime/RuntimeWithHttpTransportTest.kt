package io.furan.sdk.runtime

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.http.HttpMethod
import io.furan.sdk.http.HttpRequest
import io.furan.sdk.http.HttpResponse
import io.furan.sdk.http.HttpTransport
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicBoolean

class RuntimeWithHttpTransportTest {

    private class RecordingTransport(
        val closed: AtomicBoolean = AtomicBoolean(false),
    ) : HttpTransport {
        override suspend fun execute(request: HttpRequest): HttpResponse =
            HttpResponse(200, emptyMap(), "{}")
        override fun close() {
            closed.set(true)
        }
    }

    @Test
    fun `default bootstrap leaves runtime httpTransport null`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        assertNull(rt.httpTransport)
        rt.close()
    }

    @Test
    fun `bootstrap with httpTransportFactory builds and exposes the transport`() = runTest {
        val recording = RecordingTransport()
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            httpTransportFactory = { recording },
        ).bootstrap()

        assertNotNull(rt.httpTransport)
        assertEquals(recording, rt.httpTransport)
        val response = rt.httpTransport!!.execute(HttpRequest(HttpMethod.GET, "https://x"))
        assertEquals(200, response.statusCode)
        rt.close()
    }

    @Test
    fun `runtime close calls httpTransport close`() {
        val recording = RecordingTransport()
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            httpTransportFactory = { recording },
        ).bootstrap()
        assertEquals(false, recording.closed.get())
        rt.close()
        assertTrue(recording.closed.get(), "expected RecordingTransport.close to fire")
    }

    @Test
    fun `runtime constructed directly with an httpTransport exposes it`() {
        val recording = RecordingTransport()
        val bus = io.furan.sdk.event.SharedFlowEventBus()
        val rt = FuranRuntime(
            config = io.furan.sdk.config.DefaultConfigRegistry(emptyMap()),
            eventBus = bus,
            stateMachine = StateMachine(bus),
            httpTransport = recording,
        )
        assertEquals(recording, rt.httpTransport)
        rt.close()
        assertTrue(recording.closed.get())
    }
}
