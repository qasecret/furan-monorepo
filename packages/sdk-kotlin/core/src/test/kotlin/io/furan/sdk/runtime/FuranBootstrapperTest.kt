package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigSource
import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.event.SharedFlowEventBus
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class FuranBootstrapperTest {

    private class FakeSource(
        override val name: String,
        override val priority: Int,
        private val data: Map<String, Any?>,
    ) : ConfigSource {
        override fun load(): Map<String, Any?> = data
    }

    @Test
    fun `bootstrap produces a runtime in READY state`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        assertEquals(RuntimeState.READY, rt.state)
        assertNotNull(rt.config)
        assertNotNull(rt.eventBus)
        rt.close()
    }

    @Test
    fun `bootstrap merges supplied sources into the registry`() {
        val rt = FuranBootstrapper(sources = listOf(
            DefaultsConfigSource(),
            FakeSource("env", 100, mapOf("furan.apiUrl" to "https://from-env")),
        )).bootstrap()

        assertEquals("https://from-env", rt.config.get<String>("furan.apiUrl")?.value)
        assertEquals("env", rt.config.get<String>("furan.apiUrl")?.source)
        rt.close()
    }

    @Test
    fun `state machine inside the runtime publishes StateChangedEvent on later transitions`() = runTest {
        val bootstrapper = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            eventBusFactory = { SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler)) },
        )
        val rt = bootstrapper.bootstrap()
        val received = CopyOnWriteArrayList<StateChangedEvent>()
        rt.eventBus.subscribe(StateChangedEvent::class) { received += it }
        delay(10)

        rt.stateMachine.transition(RuntimeState.DEGRADED)
        delay(10)

        assertEquals(1, received.size)
        assertEquals(RuntimeState.READY, received[0].from)
        assertEquals(RuntimeState.DEGRADED, received[0].to)
        rt.close()
    }

    @Test
    fun `bootstrap closes runtime cleanly and idempotently`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        rt.close()
        assertEquals(RuntimeState.TERMINATED, rt.state)
        rt.close()  // idempotent
        assertTrue(true)
    }
}
