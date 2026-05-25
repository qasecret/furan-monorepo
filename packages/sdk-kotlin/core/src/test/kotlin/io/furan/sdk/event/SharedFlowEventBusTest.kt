package io.furan.sdk.event

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.delay
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class SharedFlowEventBusTest {

    private data class FooEvent(
        val n: Int,
        override val timestamp: Instant = Instant.now(),
        override val correlationId: String? = null,
    ) : FuranEvent

    private data class BarEvent(
        val s: String,
        override val timestamp: Instant = Instant.now(),
        override val correlationId: String? = null,
    ) : FuranEvent

    @Test
    fun `published events reach an all-events subscriber`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val received = CopyOnWriteArrayList<FuranEvent>()
        val sub = bus.subscribe { received += it }

        bus.publish(FooEvent(1))
        bus.publish(BarEvent("x"))

        // Drain coroutines so the collector runs.
        delay(10)

        assertEquals(2, received.size)
        assertTrue(received.any { it is FooEvent && it.n == 1 })
        assertTrue(received.any { it is BarEvent && it.s == "x" })

        sub.cancel()
        bus.close()
    }

    @Test
    fun `type-filtered subscriber only sees matching events`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val onlyFoo = CopyOnWriteArrayList<FooEvent>()
        bus.subscribe(FooEvent::class) { onlyFoo += it }

        bus.publish(FooEvent(1))
        bus.publish(BarEvent("ignored"))
        bus.publish(FooEvent(2))

        delay(10)

        assertEquals(listOf(1, 2), onlyFoo.map { it.n })

        bus.close()
    }

    @Test
    fun `cancelled subscription stops receiving events`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        val received = CopyOnWriteArrayList<FuranEvent>()
        val sub = bus.subscribe { received += it }

        bus.publish(FooEvent(1))
        delay(10)
        sub.cancel()
        bus.publish(FooEvent(2))
        delay(10)

        assertEquals(1, received.size)
        assertEquals(1, (received[0] as FooEvent).n)

        bus.close()
    }

    @Test
    fun `close stops the internal scope`() = runTest {
        val bus = SharedFlowEventBus(coroutineContext = UnconfinedTestDispatcher(testScheduler))
        bus.close()
        // Subscribing after close should still return a Subscription
        // (no NPE), but no events will flow because publish is a no-op.
        val received = CopyOnWriteArrayList<FuranEvent>()
        val sub = bus.subscribe { received += it }
        bus.publish(FooEvent(1))
        delay(10)
        assertTrue(received.isEmpty())
        sub.cancel()
    }
}
