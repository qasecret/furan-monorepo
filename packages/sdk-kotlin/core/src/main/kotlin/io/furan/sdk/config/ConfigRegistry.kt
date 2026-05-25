package io.furan.sdk.config

/**
 * Provenance-aware view of the merged configuration. Downstream code
 * reads values via [get] and operators inspect origins via [provenance]
 * or [dump]. Immutable; produced by [ConfigurationResolver].
 */
interface ConfigRegistry {
    fun <T> get(key: String): ConfigValue<T>?
    fun provenance(): Map<String, ConfigValue<*>>
    fun dump(masked: Boolean = true): String
}

class DefaultConfigRegistry(
    private val values: Map<String, ConfigValue<*>>,
    private val masker: SecretMasker = DefaultSecretMasker,
) : ConfigRegistry {

    @Suppress("UNCHECKED_CAST")
    override fun <T> get(key: String): ConfigValue<T>? =
        values[key] as ConfigValue<T>?

    override fun provenance(): Map<String, ConfigValue<*>> = values

    override fun dump(masked: Boolean): String {
        val rows = if (masked) masker.maskProvenance(values) else values
        if (rows.isEmpty()) return "(no config)"
        val keyWidth = rows.keys.maxOf { it.length }
        return rows.entries.joinToString("\n") { (key, cv) ->
            val padded = key.padEnd(keyWidth)
            "%s = %-30s (%s, p=%d)".format(padded, cv.value.toString(), cv.source, cv.priority)
        }
    }
}
