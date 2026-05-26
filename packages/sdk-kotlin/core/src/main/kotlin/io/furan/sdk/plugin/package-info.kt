/**
 * Service-provider interface and plugin lifecycle for the Furan SDK.
 *
 * ## Entry points
 *  - [FuranPlugin] — interface every plugin implements. Requires a
 *    public no-arg constructor for [java.util.ServiceLoader].
 *  - [PluginContext] — read-only access to config + event bus +
 *    capabilities registry, passed to [FuranPlugin.initialize].
 *  - [PluginInfo] — diagnostic summary returned by
 *    [PluginRegistry.list].
 *
 * ## Capability advertisement
 *  - [Capability] — sealed interface; eight built-in object instances
 *    + a [Capability.Custom] data class for user-defined ones.
 *  - [CapabilityRegistry] — thread-safe `advertise` /
 *    `has` / `providers` / `all`. Plugins call `advertise(c, name)`
 *    during `initialize` for each capability they actually provide.
 *  - [DefaultCapabilityRegistry] — `ConcurrentHashMap`-backed
 *    implementation; idempotent for `(capability, providerName)`
 *    pairs.
 *
 * ## Registration paths
 *
 * Explicit:
 *
 * ```kotlin
 * val rt = FuranBootstrapper(
 *     plugins = listOf(MyCustomPlugin(), OtelTracingPlugin()),
 * ).bootstrap()
 * ```
 *
 * SPI (Java's `ServiceLoader`):
 *
 * 1. Implement [FuranPlugin] with a public no-arg constructor.
 * 2. Add a file at
 *    `META-INF/services/io.furan.sdk.plugin.FuranPlugin` in your
 *    jar containing one line per plugin class (fully-qualified).
 * 3. Bootstrap with `loadPluginsFromClasspath = true`:
 *
 * ```kotlin
 * val rt = FuranBootstrapper(
 *     loadPluginsFromClasspath = true,
 * ).bootstrap()
 * ```
 *
 * Both paths can be combined — explicit plugins are registered first,
 * then SPI-discovered ones, in classpath order.
 *
 * ## Lifecycle
 *
 *  - `initializeAll` runs in registration order.
 *  - `shutdownAll` (called from `FuranRuntime.close()`) runs in
 *    REVERSE registration order. Each plugin's `shutdown()` is
 *    wrapped in `runCatching` — one failing plugin must not prevent
 *    the others from cleaning up.
 *
 * ## Convention: don't over-advertise
 *
 * A plugin should advertise a capability ONLY when it actually has
 * the runtime resources to back it. Discovering at `initialize` that
 * a required env var is missing? Log a warning, skip
 * `capabilities.advertise(...)`, and let downstream feature-detect
 * (`if (capabilities.has(...))`) fall through to the no-op path.
 *
 * ## What's NOT in this phase
 *  - `Ordered` / priority on plugins for fine-grained ordering — Phase 5.
 *  - Auto-derived capability advertisement from `FuranPlugin.capabilities`
 *    set — intentionally not done so plugins can refuse to advertise a
 *    capability at runtime if its prerequisites aren't met.
 *  - First-party reference plugins (`furan-otel`, `furan-credentials-vault`,
 *    `furan-audit-kafka`) — live in separate Maven artifacts; consumed by
 *    SDK users via classpath inclusion.
 *  - `telemetry: TelemetryRegistry` field on [PluginContext] — Phase 6.
 */
package io.furan.sdk.plugin
