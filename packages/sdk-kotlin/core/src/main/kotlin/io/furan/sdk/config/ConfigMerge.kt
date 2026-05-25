package io.furan.sdk.config

/**
 * Pure merge functions for dotted-key configuration maps.
 *
 * Rules (matches spec v2 §4):
 *  - Higher layer scalar replaces lower.
 *  - Higher layer `null` CLEARS the lower value (Kubernetes-style).
 *  - Nested maps REPLACE wholesale by default. Add `inherit: true` to
 *    the higher-layer map to opt in to deep merge for that subtree.
 *  - Lists REPLACE; never concatenate.
 *  - Key absent in higher layer → lower-layer value passes through.
 */
object ConfigMerge {

    private const val INHERIT_DIRECTIVE = "inherit"

    /** Merge `high` over `low`. */
    fun deepMerge(low: Map<String, Any?>, high: Map<String, Any?>): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>(low)
        for ((key, highValue) in high) {
            val lowValue = result[key]
            result[key] = mergeValue(lowValue, highValue)
        }
        return result
    }

    /** Merge a list of layers in order (first = lowest priority). */
    fun mergeAll(layers: List<Map<String, Any?>>): Map<String, Any?> =
        layers.fold(emptyMap()) { acc, layer -> deepMerge(acc, layer) }

    /**
     * Recognises both `Boolean true` (from typed sources like YAML
     * after deserialization) and the string `"true"` (from env or
     * sysprop sources which return all values as String). Anything
     * else — including `false`, `"false"`, `null`, or a missing key
     * — disables the inherit behaviour.
     */
    private fun isInheritDirective(value: Any?): Boolean = when (value) {
        true -> true
        "true" -> true
        else -> false
    }

    @Suppress("UNCHECKED_CAST")
    private fun mergeValue(low: Any?, high: Any?): Any? {
        // 1. Explicit null clears.
        if (high == null) return null

        // 2. Both maps → check inherit directive.
        if (low is Map<*, *> && high is Map<*, *>) {
            val highMap = high as Map<String, Any?>
            val inheritsLower = isInheritDirective(highMap[INHERIT_DIRECTIVE])
            return if (inheritsLower) {
                val merged = LinkedHashMap<String, Any?>(low as Map<String, Any?>)
                for ((k, v) in highMap) {
                    if (k == INHERIT_DIRECTIVE) continue
                    merged[k] = mergeValue(merged[k], v)
                }
                merged
            } else {
                // Default: replace wholesale, but still drop directive.
                highMap.filterKeys { it != INHERIT_DIRECTIVE }
            }
        }

        // 3. Any other case (scalar, list, type mismatch): high wins.
        return high
    }
}
