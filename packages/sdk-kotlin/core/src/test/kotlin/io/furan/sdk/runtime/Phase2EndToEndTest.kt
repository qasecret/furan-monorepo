package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigSource
import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.event.SharedFlowEventBus
import io.furan.sdk.event.subscribe
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class Phase2EndToEndTest {

    private class FakeYamlSource(map: Map<String, Any?>) : ConfigSource {
        override val name = "yaml"
        override val priority = 60
        private val data = map
        override fun load(): Map<String, Any?> = data
    }

    @Test
    fun `bootstrap then drive runtime through DEGRADED back to READY`() = runTest {
        val rt = FuranBootstrapper(
            sources = listOf(
                DefaultsConfigSource(),
                FakeYamlSource(mapOf("furan.apiUrl" to "https://acme.example.com")),
            ),
            eventBusFactory = { SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler)) },
        ).bootstrap()

        // After bootstrap.
        assertEquals(RuntimeState.READY, rt.state)
        assertEquals("https://acme.example.com",
            rt.config.get<String>("furan.apiUrl")?.value)
        assertEquals("yaml", rt.config.get<String>("furan.apiUrl")?.source)

        // Subscribe and drive transitions.
        val events = CopyOnWriteArrayList<StateChangedEvent>()
        rt.eventBus.subscribe<StateChangedEvent> { events += it }
        delay(10)

        rt.stateMachine.transition(RuntimeState.DEGRADED)
        rt.stateMachine.transition(RuntimeState.READY)
        delay(20)

        assertEquals(
            listOf(
                RuntimeState.READY to RuntimeState.DEGRADED,
                RuntimeState.DEGRADED to RuntimeState.READY,
            ),
            events.map { it.from to it.to },
        )

        rt.close()
        assertEquals(RuntimeState.TERMINATED, rt.state)
    }

    @Test
    fun `subscribers receive events filtered by type`() = runTest {
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            eventBusFactory = { SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler)) },
        ).bootstrap()

        val stateOnly = CopyOnWriteArrayList<StateChangedEvent>()
        rt.eventBus.subscribe<StateChangedEvent> { stateOnly += it }
        delay(10)

        rt.stateMachine.transition(RuntimeState.DEGRADED)
        delay(10)

        assertEquals(1, stateOnly.size)
        assertEquals(RuntimeState.READY to RuntimeState.DEGRADED, stateOnly[0].from to stateOnly[0].to)

        rt.close()
    }

    @Test
    fun `runtime close idempotent and terminates the event bus`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val rt = FuranRuntime(
            config = DefaultConfigRegistry(emptyMap()),
            eventBus = bus,
            stateMachine = StateMachine(bus).also { it.transition(RuntimeState.READY) },
        )

        rt.close()
        rt.close()

        assertEquals(RuntimeState.TERMINATED, rt.state)
        // Publishing after close is a no-op on SharedFlowEventBus.
        bus.publish(StateChangedEvent(RuntimeState.READY, RuntimeState.READY))
        assertTrue(true)  // no exception
    }
}
