package io.furan.sdk.config

/**
 * A single, ordered contributor to the merged Furan SDK configuration.
 * Sources are overlaid lowest-priority-first by [ConfigurationResolver];
 * higher-priority sources override lower ones. Keys are dotted paths
 * rooted at `furan.` (e.g. `"furan.retry.maxAttempts"`).
 *
 * Implementations must be pure: `load()` may be called repeatedly and
 * must not mutate process-wide state. Read from env / sysprops / files
 * is fine; writes are not.
 */
interface ConfigSource {
    /** Diagnostic name surfaced in [ConfigValue.source]. */
    val name: String

    /** Higher value wins on overlap. See [ConfigPriority] for the
     *  canonical ladder. */
    val priority: Int

    /** Returns the source's contribution as dotted-key map. */
    fun load(): Map<String, Any?>
}

/**
 * Canonical priority ladder. Concrete sources should reference these
 * constants rather than hardcoding numbers, so the ordering stays
 * documented in one place.
 */
object ConfigPriority {
    const val ENV: Int = 100
    const val SYSPROP: Int = 90
    const val DEFAULTS: Int = 10
}
