package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import io.furan.sdk.config.ConfigSource

/**
 * Reads environment variables matching `FURAN_*` and translates them
 * to dotted, camelCase keys rooted at `furan.`.
 *
 * Translation rule (Spring-style relaxed binding):
 *  - Single `_` is a PATH separator.
 *  - Double `__` is a camelCase BOUNDARY within a path segment.
 *  - Everything after `FURAN_` is lowercased.
 *
 * Examples:
 *  - `FURAN_API__URL`                    → `furan.apiUrl`
 *  - `FURAN_RETRY_MAX__ATTEMPTS`         → `furan.retry.maxAttempts`
 *  - `FURAN_TRANSPORT_GZIP`              → `furan.transport.gzip`
 *  - `FURAN_TRANSPORT_TLS_CLIENT__CERT`  → `furan.transport.tls.clientCert`
 *  - `FURAN_OBSERVABILITY_TRACING_ENABLED` → `furan.observability.tracing.enabled`
 *
 * For testability, the env lookup is injected. Production code uses
 * the [forSystem] factory.
 */
class EnvConfigSource(
    private val lookup: (String) -> String?,
    private val enumerate: () -> Set<String>,
) : ConfigSource {

    override val name: String = "env"
    override val priority: Int = ConfigPriority.ENV

    override fun load(): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        for (rawKey in enumerate()) {
            if (!rawKey.startsWith(PREFIX)) continue
            val value = lookup(rawKey) ?: continue
            result[translate(rawKey)] = value
        }
        return result
    }

    private fun translate(rawKey: String): String {
        val stripped = rawKey.removePrefix(PREFIX).lowercase()
        // Replace `__` with a sentinel so the path-separator split
        // doesn't break camelCase boundaries. Space is safe here
        // because env-var names never contain spaces.
        val sentinel = ' '
        val protectedString = stripped.replace("__", sentinel.toString())
        val pathSegments = protectedString.split('_').filter { it.isNotEmpty() }
        val camelSegments = pathSegments.map { seg ->
            val parts = seg.split(sentinel)
            parts.first() + parts.drop(1).joinToString("") {
                it.replaceFirstChar(Char::uppercase)
            }
        }
        return (listOf(PATH_ROOT) + camelSegments).joinToString(".")
    }

    companion object {
        private const val PREFIX = "FURAN_"
        private const val PATH_ROOT = "furan"

        /** Production factory that wires to the real process env. */
        fun forSystem(): EnvConfigSource = EnvConfigSource(
            lookup = { System.getenv(it) },
            enumerate = { System.getenv().keys },
        )
    }
}
