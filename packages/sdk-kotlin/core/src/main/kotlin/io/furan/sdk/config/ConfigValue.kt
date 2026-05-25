package io.furan.sdk.config

/**
 * A resolved configuration value with its origin attached. Operators
 * (and `RuntimeDiagnostics.dump()`) read this to answer "why is this
 * value what it is?" without re-walking the source list.
 */
data class ConfigValue<T>(
    /** The resolved value at the highest-priority source that contributed this key. */
    val value: T,
    /** Diagnostic label of the contributing source — e.g. `"env"`, `"sysprop"`, `"yaml:application.yml"`. */
    val source: String,
    /** Numeric priority of the contributing source. See [ConfigPriority]. */
    val priority: Int,
)
