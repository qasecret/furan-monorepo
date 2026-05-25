package io.furan.sdk.runtime

import io.furan.sdk.event.FuranEvent
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class RuntimeStateTest {

    @Test
    fun `RuntimeState has all six required states`() {
        val states = RuntimeState.values().toSet()
        assertEquals(
            setOf(
                RuntimeState.INITIALIZING,
                RuntimeState.READY,
                RuntimeState.DEGRADED,
                RuntimeState.RELOADING,
                RuntimeState.SHUTTING_DOWN,
                RuntimeState.TERMINATED,
            ),
            states,
        )
    }

    @Test
    fun `StateChangedEvent captures from to and timestamp`() {
        val before = Instant.now()
        val ev = StateChangedEvent(
            from = RuntimeState.INITIALIZING,
            to = RuntimeState.READY,
            correlationId = "boot-1",
        )
        val after = Instant.now()
        assertEquals(RuntimeState.INITIALIZING, ev.from)
        assertEquals(RuntimeState.READY, ev.to)
        assertEquals("boot-1", ev.correlationId)
        assertTrue(!ev.timestamp.isBefore(before))
        assertTrue(!ev.timestamp.isAfter(after))
    }

    @Test
    fun `StateChangedEvent is a FuranEvent`() {
        val ev: FuranEvent = StateChangedEvent(
            from = RuntimeState.READY,
            to = RuntimeState.DEGRADED,
        )
        assertTrue(ev is StateChangedEvent)
    }
}
