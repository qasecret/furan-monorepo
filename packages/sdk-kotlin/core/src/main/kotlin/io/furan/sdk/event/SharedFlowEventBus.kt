package io.furan.sdk.event

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import kotlin.reflect.KClass

/**
 * `MutableSharedFlow`-backed [EventBus]. Single instance per
 * [io.furan.sdk.runtime.FuranRuntime]. Internally owns a
 * [SupervisorJob]-scoped [CoroutineScope] on which subscriber
 * collectors run; closing the bus cancels every subscriber.
 *
 * Defaults:
 *  - `bufferCapacity = 1024` events; `DROP_OLDEST` on overflow.
 *  - Subscribers collect on [Dispatchers.Unconfined] by default —
 *    handlers are invoked on the emitting thread and must not block.
 *    Pass an explicit [coroutineContext] (e.g. [Dispatchers.Default])
 *    if background dispatch is required.
 *
 * Closing is idempotent. Publishing after close is a no-op.
 */
class SharedFlowEventBus(
    bufferCapacity: Int = DEFAULT_BUFFER_CAPACITY,
    coroutineContext: CoroutineContext = Dispatchers.Unconfined,
) : EventBus, AutoCloseable {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + coroutineContext)
    private val closed = AtomicBoolean(false)

    private val flow = MutableSharedFlow<FuranEvent>(
        replay = 0,
        extraBufferCapacity = bufferCapacity,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    override fun publish(event: FuranEvent) {
        if (closed.get()) return
        flow.tryEmit(event)  // Bounded buffer + DROP_OLDEST → tryEmit never returns false here.
    }

    override fun subscribe(handler: (FuranEvent) -> Unit): Subscription {
        if (closed.get()) return Subscription { /* no-op */ }
        val job = scope.launch {
            flow.asSharedFlow().collect { handler(it) }
        }
        return jobSubscription(job)
    }

    override fun <T : FuranEvent> subscribe(
        type: KClass<T>,
        handler: (T) -> Unit,
    ): Subscription {
        if (closed.get()) return Subscription { /* no-op */ }
        val job = scope.launch {
            flow.asSharedFlow().collect { event ->
                if (type.isInstance(event)) {
                    @Suppress("UNCHECKED_CAST")
                    handler(event as T)
                }
            }
        }
        return jobSubscription(job)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        scope.cancel()
    }

    private fun jobSubscription(job: Job): Subscription = Subscription { job.cancel() }

    private companion object {
        const val DEFAULT_BUFFER_CAPACITY: Int = 1024
    }
}
