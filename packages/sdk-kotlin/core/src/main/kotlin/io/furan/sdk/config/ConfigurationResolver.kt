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
        // Snapshot each source's contribution exactly once to avoid
        // TOCTOU races (System.getProperties() is mutable) and to
        // halve the I/O cost of the provenance pass below.
        val snapshots: List<Pair<ConfigSource, Map<String, Any?>>> =
            sorted.map { it to it.load() }

        // First pass: merged values via ConfigMerge.
        val merged = ConfigMerge.mergeAll(snapshots.map { it.second })

        // Second pass: for each merged key, find the highest-priority
        // source that contributed it. A higher source that set a key
        // to null still wins (provenance shows where the clear came
        // from).
        val provenance = LinkedHashMap<String, ConfigValue<*>>()
        for ((key, value) in merged) {
            val winner = highestSourceFor(key, snapshots)
                ?: error("internal: no source contributed key $key")
            provenance[key] = ConfigValue(value, winner.name, winner.priority)
        }

        return DefaultConfigRegistry(provenance)
    }

    private fun highestSourceFor(
        key: String,
        snapshots: List<Pair<ConfigSource, Map<String, Any?>>>,
    ): ConfigSource? {
        // snapshots is lowest-priority-first; iterate reversed.
        for ((src, data) in snapshots.asReversed()) {
            if (data.containsKey(key)) return src
        }
        return null
    }
}
