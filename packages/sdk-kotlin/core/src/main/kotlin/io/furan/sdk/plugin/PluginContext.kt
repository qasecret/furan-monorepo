package io.furan.sdk.plugin

import io.furan.sdk.config.ConfigRegistry
import io.furan.sdk.event.EventBus

/**
 * Read-only context handed to [FuranPlugin.initialize]. Gives the
 * plugin access to the SDK's spine — config, event bus, capability
 * registry — without exposing the mutable internals of the runtime.
 *
 * Plugins should NOT cache the context across calls; it's valid only
 * for the lifetime of the `initialize` invocation. Cache the
 * specific fields (e.g. a Subscription returned from
 * `eventBus.subscribe`) if needed.
 *
 * Future fields (Phase 6+):
 *  - `telemetry: TelemetryRegistry` — for metric/span registration.
 *  - `diagnostics: RuntimeDiagnostics` — read-only snapshot view.
 */
data class PluginContext(
    val config: ConfigRegistry,
    val eventBus: EventBus,
    val capabilities: CapabilityRegistry,
)
