package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import io.furan.sdk.config.ConfigSource
import java.util.Properties

/**
 * Reads JVM system properties matching `furan.*`. Keys are used
 * verbatim (already dotted, already camelCase). Used for ad-hoc
 * overrides in tests / CI: `-Dfuran.retry.maxAttempts=5`.
 *
 * The literal string `"null"` is decoded to `null` so operators can
 * clear inherited values via the merge null-clears rule (see
 * ConfigMerge).
 */
class SystemPropertyConfigSource(
    private val propsProvider: () -> Properties,
) : ConfigSource {

    override val name: String = "sysprop"
    override val priority: Int = ConfigPriority.SYSPROP

    override fun load(): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        val props = propsProvider()
        for (key in props.stringPropertyNames()) {
            if (!key.startsWith(PREFIX)) continue
            val raw = props.getProperty(key)
            result[key] = if (raw == NULL_LITERAL) null else raw
        }
        return result
    }

    companion object {
        private const val PREFIX = "furan."
        private const val NULL_LITERAL = "null"

        /** Production factory that reads `System.getProperties()`. */
        fun forSystem(): SystemPropertyConfigSource =
            SystemPropertyConfigSource(propsProvider = { System.getProperties() })
    }
}
