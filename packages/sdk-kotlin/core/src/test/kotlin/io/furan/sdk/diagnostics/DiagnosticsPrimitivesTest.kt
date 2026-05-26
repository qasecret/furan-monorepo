package io.furan.sdk.diagnostics

import io.furan.sdk.runtime.RuntimeState
import io.furan.sdk.runtime.StateChangedEvent
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class DiagnosticsPrimitivesTest {

    @Test
    fun `FuranEventSummary captures type-name, timestamp, correlationId, and stringified value`() {
        val now = Instant.now()
        val ev = StateChangedEvent(
            from = RuntimeState.INITIALIZING,
            to = RuntimeState.READY,
            correlationId = "boot-1",
            timestamp = now,
        )
        val summary = FuranEventSummary.from(ev)
        assertEquals("StateChangedEvent", summary.typeName)
        assertEquals(now, summary.timestamp)
        assertEquals("boot-1", summary.correlationId)
        assertTrue(summary.description.contains("INITIALIZING"))
        assertTrue(summary.description.contains("READY"))
    }

    @Test
    fun `FuranEventSummary description handles null correlationId`() {
        val ev = StateChangedEvent(
            from = RuntimeState.READY,
            to = RuntimeState.DEGRADED,
            correlationId = null,
        )
        val summary = FuranEventSummary.from(ev)
        assertEquals(null, summary.correlationId)
        assertNotNull(summary.description)
        assertTrue(summary.description.isNotBlank())
    }

    @Test
    fun `MemoryStats snapshot returns non-negative values for heap`() {
        val s = MemoryStats.snapshot()
        assertTrue(s.heapUsedBytes >= 0, "heapUsedBytes = ${s.heapUsedBytes}")
        assertTrue(s.heapCommittedBytes >= 0, "heapCommittedBytes = ${s.heapCommittedBytes}")
        assertTrue(s.heapMaxBytes >= 0, "heapMaxBytes = ${s.heapMaxBytes}")
    }

    @Test
    fun `MemoryStats fields are structurally equal as a data class`() {
        val a = MemoryStats(heapUsedBytes = 100, heapCommittedBytes = 200, heapMaxBytes = 1000)
        val b = MemoryStats(heapUsedBytes = 100, heapCommittedBytes = 200, heapMaxBytes = 1000)
        assertEquals(a, b)
    }
}
