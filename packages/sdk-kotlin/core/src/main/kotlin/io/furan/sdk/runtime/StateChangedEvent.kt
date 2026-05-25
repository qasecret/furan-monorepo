package io.furan.sdk.runtime

import io.furan.sdk.event.FuranEvent
import java.time.Instant

/**
 * Published by [StateMachine] on every successful transition.
 * Subscribers can react (e.g. flip a health probe), but should not
 * trigger further transitions synchronously from the event handler
 * to avoid recursive state changes.
 */
data class StateChangedEvent(
    val from: RuntimeState,
    val to: RuntimeState,
    override val correlationId: String? = null,
    override val timestamp: Instant = Instant.now(),
) : FuranEvent
