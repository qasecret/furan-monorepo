package io.furan.sdk.diagnostics

import io.furan.sdk.event.SharedFlowEventBus
import io.furan.sdk.runtime.RuntimeState
import io.furan.sdk.runtime.StateChangedEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RecentEventsBufferTest {

    @Test
    fun `subscribes to the bus and records each event as a summary in order`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val buf = RecentEventsBuffer(capacity = 8)
        buf.attach(bus)
        delay(10)

        bus.publish(StateChangedEvent(RuntimeState.INITIALIZING, RuntimeState.READY))
        bus.publish(StateChangedEvent(RuntimeState.READY, RuntimeState.DEGRADED))
        delay(10)

        val snap = buf.snapshot()
        assertEquals(2, snap.size)
        assertEquals("StateChangedEvent", snap[0].typeName)
        assertTrue(snap[0].description.contains("INITIALIZING"))
        assertTrue(snap[1].description.contains("DEGRADED"))

        buf.detach()
        bus.close()
    }

    @Test
    fun `ring buffer drops oldest when capacity exceeded`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val buf = RecentEventsBuffer(capacity = 3)
        buf.attach(bus)
        delay(10)

        repeat(5) { i ->
            val from = if (i % 2 == 0) RuntimeState.READY else RuntimeState.DEGRADED
            val to = if (i % 2 == 0) RuntimeState.DEGRADED else RuntimeState.READY
            bus.publish(StateChangedEvent(from = from, to = to, correlationId = "evt-${i}"))
        }
        delay(20)

        val snap = buf.snapshot()
        assertEquals(3, snap.size)
        assertEquals("evt-2", snap[0].correlationId)
        assertEquals("evt-3", snap[1].correlationId)
        assertEquals("evt-4", snap[2].correlationId)

        buf.detach()
        bus.close()
    }

    @Test
    fun `detach stops recording further events`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val buf = RecentEventsBuffer(capacity = 8)
        buf.attach(bus)
        delay(10)

        bus.publish(StateChangedEvent(RuntimeState.INITIALIZING, RuntimeState.READY, correlationId = "before"))
        delay(10)
        buf.detach()
        bus.publish(StateChangedEvent(RuntimeState.READY, RuntimeState.DEGRADED, correlationId = "after"))
        delay(10)

        val snap = buf.snapshot()
        assertEquals(1, snap.size)
        assertEquals("before", snap[0].correlationId)

        bus.close()
    }

    @Test
    fun `snapshot returns an immutable copy — later events do not mutate previous snapshots`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val buf = RecentEventsBuffer(capacity = 8)
        buf.attach(bus)
        delay(10)

        bus.publish(StateChangedEvent(RuntimeState.INITIALIZING, RuntimeState.READY, correlationId = "first"))
        delay(10)
        val firstSnap = buf.snapshot()

        bus.publish(StateChangedEvent(RuntimeState.READY, RuntimeState.DEGRADED, correlationId = "second"))
        delay(10)
        val secondSnap = buf.snapshot()

        assertEquals(1, firstSnap.size)
        assertEquals(2, secondSnap.size)
        assertEquals("first", firstSnap[0].correlationId)
        assertEquals(1, firstSnap.size)

        buf.detach()
        bus.close()
    }
}
