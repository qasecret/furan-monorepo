package io.furan.sdk.runtime

import io.furan.sdk.event.SharedFlowEventBus
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class StateMachineTest {

    @Test
    fun `initial state is INITIALIZING`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus)
        assertEquals(RuntimeState.INITIALIZING, sm.current())
        bus.close()
    }

    @Test
    fun `valid transition INITIALIZING to READY succeeds`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus)
        sm.transition(RuntimeState.READY)
        assertEquals(RuntimeState.READY, sm.current())
        bus.close()
    }

    @Test
    fun `invalid transition throws IllegalStateException`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus)
        // INITIALIZING -> DEGRADED is not allowed.
        val ex = assertThrows(IllegalStateException::class.java) {
            sm.transition(RuntimeState.DEGRADED)
        }
        assertTrue(ex.message!!.contains("INITIALIZING"))
        assertTrue(ex.message!!.contains("DEGRADED"))
        // State unchanged after failed transition.
        assertEquals(RuntimeState.INITIALIZING, sm.current())
        bus.close()
    }

    @Test
    fun `TERMINATED is terminal — no further transitions allowed`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val sm = StateMachine(bus)
        sm.transition(RuntimeState.READY)
        sm.transition(RuntimeState.SHUTTING_DOWN)
        sm.transition(RuntimeState.TERMINATED)
        assertThrows(IllegalStateException::class.java) {
            sm.transition(RuntimeState.READY)
        }
        assertEquals(RuntimeState.TERMINATED, sm.current())
        bus.close()
    }

    @Test
    fun `successful transition publishes StateChangedEvent on the bus`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val received = CopyOnWriteArrayList<StateChangedEvent>()
        bus.subscribe(StateChangedEvent::class) { received += it }
        // Let the subscriber attach before we publish.
        delay(10)

        val sm = StateMachine(bus)
        sm.transition(RuntimeState.READY)
        sm.transition(RuntimeState.DEGRADED)

        delay(20)

        assertEquals(2, received.size)
        assertEquals(RuntimeState.INITIALIZING, received[0].from)
        assertEquals(RuntimeState.READY, received[0].to)
        assertEquals(RuntimeState.READY, received[1].from)
        assertEquals(RuntimeState.DEGRADED, received[1].to)

        bus.close()
    }
}
