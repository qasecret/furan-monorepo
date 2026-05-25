package io.furan.sdk.config

/**
 * A resolved configuration value with its origin attached. Operators
 * (and `RuntimeDiagnostics.dump()`) read this to answer "why is this
 * value what it is?" without re-walking the source list.
 */
data class ConfigValue<T>(
    val value: T,
    val source: String,
    val priority: Int,
)
