/**
 * Fan-out notification spine for the Furan SDK runtime.
 *
 * ## Types
 *  - [FuranEvent] — marker interface every event implements.
 *  - [EventBus] — pub-sub abstraction.
 *  - [SharedFlowEventBus] — bounded `MutableSharedFlow`-backed impl
 *    with `DROP_OLDEST` overflow and a `SupervisorJob`-scoped
 *    subscriber dispatcher.
 *  - [Subscription] — handle returned by `subscribe`; call `cancel()`
 *    to detach.
 *
 * ## Contract
 *  - Fan-out only; subsystems still talk via direct typed references.
 *  - Publishers never block on subscribers.
 *  - Subscribers must be non-blocking and idempotent.
 *
 * ## Events defined elsewhere
 *  - [io.furan.sdk.config.ConfigReloadedEvent]
 *  - [io.furan.sdk.runtime.StateChangedEvent]
 */
package io.furan.sdk.event
