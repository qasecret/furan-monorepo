package io.furan.sdk.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class ConfigReloadedEventTest {

    @Test
    fun `event captures changed keys and a timestamp`() {
        val before = Instant.now()
        val ev = ConfigReloadedEvent(
            changed = setOf("furan.endpoint", "furan.retry.maxAttempts"),
            correlationId = "reload-1",
        )
        val after = Instant.now()
        assertEquals(setOf("furan.endpoint", "furan.retry.maxAttempts"), ev.changed)
        assertEquals("reload-1", ev.correlationId)
        assertTrue(!ev.timestamp.isBefore(before))
        assertTrue(!ev.timestamp.isAfter(after))
    }

    @Test
    fun `event is a FuranEvent`() {
        val ev: FuranEvent = ConfigReloadedEvent(changed = emptySet())
        assertEquals(emptySet<String>(), (ev as ConfigReloadedEvent).changed)
    }
}
