/**
 * Runtime orchestration for the Furan SDK — the spine that holds
 * configuration, the event bus, and lifecycle state. Phase 2 ships a
 * minimal surface; Phase 3+ extend it with transport, endpoint
 * resolution, async queues, plugins, and diagnostics.
 *
 * ## Entry points
 *  - [FuranBootstrapper] — builds a fully-initialized runtime from
 *    a list of [io.furan.sdk.config.ConfigSource]s. The default
 *    source list is env + sysprop + built-in defaults.
 *  - [FuranRuntime] — the container produced by the bootstrapper.
 *    Holds [io.furan.sdk.config.ConfigRegistry],
 *    [io.furan.sdk.event.EventBus], and [StateMachine]. Implements
 *    [AutoCloseable].
 *  - [StateMachine] — owns the [RuntimeState] and validates allowed
 *    transitions; publishes [StateChangedEvent] on every move.
 *
 * ## Lifecycle
 *  ```
 *  INITIALIZING → READY → (DEGRADED | RELOADING) → SHUTTING_DOWN → TERMINATED
 *  ```
 *
 * ## What's NOT in this phase
 *  - `HttpTransport` interface extraction → Phase 3
 *  - `EndpointResolver` chain → Phase 3
 *  - `PluginRegistry` / `CapabilityRegistry` → Phase 4
 *  - Partitioned `AsyncSubsystem` → Phase 5
 *  - `RuntimeDiagnostics` snapshot API → Phase 6
 *  - `FuranClient.fromRuntime(...)` integration → follow-up that
 *    lands typed `ConfigRegistry.bound<FuranConfig>()`
 */
package io.furan.sdk.runtime
