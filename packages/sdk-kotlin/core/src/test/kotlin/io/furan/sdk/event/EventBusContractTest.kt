package io.furan.sdk.event

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class EventBusContractTest {

    private data class SampleEvent(
        val payload: String,
        override val timestamp: Instant = Instant.now(),
        override val correlationId: String? = null,
    ) : FuranEvent

    @Test
    fun `EventBus is an interface with publish and subscribe methods`() {
        val received = mutableListOf<FuranEvent>()
        val bus = object : EventBus {
            override fun publish(event: FuranEvent) { received += event }
            override fun subscribe(handler: (FuranEvent) -> Unit): Subscription {
                return Subscription { /* no-op for this stub */ }
            }
            override fun <T : FuranEvent> subscribe(
                type: kotlin.reflect.KClass<T>,
                handler: (T) -> Unit,
            ): Subscription = Subscription { }
        }
        bus.publish(SampleEvent("hi"))
        assertEquals(1, received.size)
        assertEquals("hi", (received[0] as SampleEvent).payload)
    }

    @Test
    fun `Subscription is closeable via cancel`() {
        var cancelled = false
        val sub = Subscription { cancelled = true }
        assertTrue(!cancelled)
        sub.cancel()
        assertTrue(cancelled)
    }
}
