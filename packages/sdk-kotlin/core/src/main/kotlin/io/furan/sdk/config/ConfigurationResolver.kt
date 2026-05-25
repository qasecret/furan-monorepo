package io.furan.sdk.config

/**
 * Orchestrates a list of [ConfigSource]s into a single
 * [ConfigRegistry]. Overlays layers lowest-priority-first using
 * [ConfigMerge], then attaches per-key provenance based on which
 * source last contributed each key.
 *
 * Stateless and safe to invoke multiple times; downstream callers
 * (FuranBootstrapper in a future phase) own the resulting registry.
 */
class ConfigurationResolver(
    private val sources: List<ConfigSource>,
) {
    fun resolve(): ConfigRegistry {
        val sorted = sources.sortedBy { it.priority }

        // First pass: merged values via ConfigMerge.
        val merged = ConfigMerge.mergeAll(sorted.map { it.load() })

        // Second pass: for each merged key, find the highest-priority
        // source that contributed it. A higher source that set a key
        // to null still wins (provenance shows where the clear came
        // from).
        val provenance = LinkedHashMap<String, ConfigValue<*>>()
        for ((key, value) in merged) {
            val winner = highestSourceFor(key, sorted)
                ?: error("internal: no source contributed key $key")
            provenance[key] = ConfigValue(value, winner.name, winner.priority)
        }

        return DefaultConfigRegistry(provenance)
    }

    private fun highestSourceFor(key: String, sortedSources: List<ConfigSource>): ConfigSource? {
        // sortedSources is lowest-priority-first; iterate reversed.
        for (src in sortedSources.asReversed()) {
            if (src.load().containsKey(key)) return src
        }
        return null
    }
}
