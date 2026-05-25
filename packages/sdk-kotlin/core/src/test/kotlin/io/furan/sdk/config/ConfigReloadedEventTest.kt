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
            changedKeys = setOf("furan.endpoint", "furan.retry.maxAttempts"),
            correlationId = "reload-1",
        )
        val after = Instant.now()
        assertEquals(setOf("furan.endpoint", "furan.retry.maxAttempts"), ev.changedKeys)
        assertEquals("reload-1", ev.correlationId)
        assertTrue(!ev.timestamp.isBefore(before))
        assertTrue(!ev.timestamp.isAfter(after))
    }

    @Test
    fun `event is a FuranEvent`() {
        val ev: FuranEvent = ConfigReloadedEvent(changedKeys = emptySet())
        assertEquals(emptySet<String>(), (ev as ConfigReloadedEvent).changedKeys)
    }
}
