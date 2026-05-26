package io.furan.sdk.plugin

/**
 * Service-provider interface for third-party plugins. Implementations
 * live in separate Maven artifacts and are loaded by the SDK at boot
 * either explicitly (via [PluginRegistry.add]) or via Java's
 * [java.util.ServiceLoader] (via [PluginRegistry.loadFromClasspath]).
 *
 * **SPI requirement:** implementations MUST have a no-arg public
 * constructor for `ServiceLoader` to instantiate them. Configuration
 * is read from the [PluginContext] passed to [initialize], not from
 * constructor arguments.
 *
 * Lifecycle:
 *  - [initialize] runs once at runtime bootstrap, in plugin
 *    registration order. The plugin advertises its capabilities here
 *    and may subscribe to the [io.furan.sdk.event.EventBus].
 *  - [shutdown] runs once at runtime close, in REVERSE registration
 *    order. Default is a no-op. The plugin should release any
 *    resources it holds (HTTP clients, file watchers, etc).
 */
interface FuranPlugin {
    /** Diagnostic name surfaced in [PluginInfo] and provenance dumps. */
    val name: String

    /** Capabilities this plugin provides. Advertised to the
     *  [CapabilityRegistry] during [initialize] (the plugin must call
     *  `context.capabilities.advertise(c, name)` for each capability
     *  it offers — the SDK does NOT auto-advertise from this set,
     *  because the plugin may discover at runtime that a capability
     *  it nominally provides is unavailable for environmental
     *  reasons). Defaults to empty.
     */
    val capabilities: Set<Capability> get() = emptySet()

    /** Called once at bootstrap. The plugin should advertise its
     *  capabilities, subscribe to the event bus if needed, and bind
     *  any startup resources. Must not block — long-running work
     *  belongs in a coroutine launched on the context's resources. */
    fun initialize(context: PluginContext)

    /** Called once at runtime close, in REVERSE registration order.
     *  Default is a no-op. */
    fun shutdown() = Unit
}
