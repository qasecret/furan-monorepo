package io.furan.sdk.plugin

/**
 * A capability a plugin advertises to the rest of the SDK. Consumers
 * call [CapabilityRegistry.has] to check whether a capability is
 * provided by any loaded plugin before depending on its behavior.
 *
 * The built-in capabilities cover the well-known integrations
 * (OTel tracing/metrics, Vault credentials, Spring runtime, mTLS,
 * etc.); the [Custom] case lets plugins define their own without
 * recompiling the SDK.
 *
 * Capabilities are identified by a string [key] for stable diagnostic
 * output (e.g. `runtime.diagnostics.snapshot().capabilities` JSON).
 */
sealed interface Capability {
    val key: String

    object Tracing : Capability { override val key: String = "tracing" }
    object Metrics : Capability { override val key: String = "metrics" }
    object OfflineBuffering : Capability { override val key: String = "offline-buffer" }
    object SpringRuntime : Capability { override val key: String = "spring-runtime" }
    object VaultSupport : Capability { override val key: String = "vault" }
    object MTls : Capability { override val key: String = "mtls" }
    object RegionAware : Capability { override val key: String = "region-aware" }
    object CircuitBreaker : Capability { override val key: String = "circuit-breaker" }

    /**
     * User-defined capability. Two `Custom` instances with the same
     * [key] are equal (data class equality); a `Custom("tracing")`
     * is NOT equal to the [Tracing] object even though they share a
     * key string — different concrete types intentionally compare
     * unequal so plugins can't accidentally collide with built-ins.
     */
    data class Custom(override val key: String) : Capability
}
