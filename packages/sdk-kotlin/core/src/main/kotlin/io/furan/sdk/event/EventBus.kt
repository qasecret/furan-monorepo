package io.furan.sdk.event

import kotlin.reflect.KClass

/**
 * The SDK's internal pub-sub spine. Subsystems publish events on
 * meaningful state changes (config reload, circuit open, state
 * transition) and external plugins subscribe to react.
 *
 * Contract:
 *  - Delivery is fire-and-forget — publishers do not block on
 *    subscriber latency.
 *  - The default impl ([SharedFlowEventBus]) uses a bounded buffer
 *    with `DROP_OLDEST` overflow — slow subscribers WILL miss events
 *    under burst.
 *  - Subscribers must be non-blocking and side-effect-free with
 *    respect to the bus itself (publishing from a subscriber is
 *    allowed but discouraged — be aware of feedback loops).
 *
 * The bus is fan-out only. Direct typed references — not the bus —
 * remain the load-bearing inter-subsystem comm channel.
 */
interface EventBus {
    /** Publish an event. Non-blocking; failure to deliver is silent
     *  per the contract above. */
    fun publish(event: FuranEvent)

    /** Subscribe to every event flowing through the bus. */
    fun subscribe(handler: (FuranEvent) -> Unit): Subscription

    /** Subscribe to events of a specific type (and its subtypes). */
    fun <T : FuranEvent> subscribe(type: KClass<T>, handler: (T) -> Unit): Subscription
}

/**
 * Handle returned by [EventBus.subscribe]. Cancel to detach the
 * subscriber and release any internal resources held on its behalf.
 */
fun interface Subscription {
    fun cancel()
}

/**
 * Reified-generic ergonomic overload — `bus.subscribe<MyEvent> { ... }`.
 */
inline fun <reified T : FuranEvent> EventBus.subscribe(
    noinline handler: (T) -> Unit,
): Subscription = subscribe(T::class, handler)
