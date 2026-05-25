package io.furan.sdk.config

import io.furan.sdk.event.FuranEvent
import java.time.Instant

/**
 * Published when the SDK successfully completes a hot-reload of its
 * configuration. `changed` lists the dotted keys whose effective
 * value differs from the previous registry — subscribers can react
 * selectively (e.g. only rebuild the transport if endpoint or
 * security keys changed).
 */
data class ConfigReloadedEvent(
    val changed: Set<String>,
    override val correlationId: String? = null,
    override val timestamp: Instant = Instant.now(),
) : FuranEvent
