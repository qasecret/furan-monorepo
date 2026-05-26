package io.furan.sdk.plugin

/**
 * Summary tuple returned by [PluginRegistry.list] — a snapshot of
 * what's loaded for diagnostics output (e.g. `RuntimeDiagnostics`
 * snapshots will include the plugin list).
 */
data class PluginInfo(
    val name: String,
    val capabilities: Set<Capability>,
)
