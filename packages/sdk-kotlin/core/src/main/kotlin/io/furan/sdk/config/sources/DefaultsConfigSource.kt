package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import io.furan.sdk.config.ConfigSource

/**
 * SDK built-in defaults — the lowest-priority layer. Future phases
 * will derive this map from `FuranConfig`'s default values via
 * reflection; for Phase 1 we hand-curate the set of well-known keys.
 */
class DefaultsConfigSource(
    private val overrides: Map<String, Any?> = emptyMap(),
) : ConfigSource {

    override val name: String = "defaults"
    override val priority: Int = ConfigPriority.DEFAULTS

    override fun load(): Map<String, Any?> {
        val base = LinkedHashMap<String, Any?>(BUILT_INS)
        base.putAll(overrides)
        return base
    }

    private companion object {
        val BUILT_INS: Map<String, Any?> = linkedMapOf(
            // Retry
            "furan.retry.enabled" to true,
            "furan.retry.maxAttempts" to 3,
            "furan.retry.initialBackoffMillis" to 250L,
            "furan.retry.maxBackoffMillis" to 10_000L,
            "furan.retry.jitter" to 0.2,

            // Transport
            "furan.transport.gzip" to true,
            "furan.transport.maxConnections" to 64,
            "furan.transport.connectTimeoutMillis" to 5_000L,
            "furan.transport.readTimeoutMillis" to 30_000L,
            "furan.transport.writeTimeoutMillis" to 30_000L,

            // Observability
            "furan.observability.logEffectiveConfig" to true,
            "furan.observability.debug" to false,
        )
    }
}
