package io.furan.sdk.plugin

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Tracks which [Capability] each loaded plugin provides. Consumers
 * use [has] to feature-detect before depending on capability-specific
 * behavior (e.g. only emit tracing spans if [Capability.Tracing] is
 * advertised — otherwise skip the work).
 *
 * Plugin authors call [advertise] from inside [FuranPlugin.initialize]
 * to register themselves as a provider for one or more capabilities.
 * Multiple plugins can advertise the same capability; [providers]
 * returns all of them in registration order so consumers that care
 * (e.g. choose-first-or-skip-others) can pick deterministically.
 */
interface CapabilityRegistry {
    fun has(capability: Capability): Boolean
    fun providers(capability: Capability): List<String>
    fun advertise(capability: Capability, providerName: String)
    fun all(): Map<Capability, List<String>>
}

/**
 * Default thread-safe implementation. Backed by [ConcurrentHashMap]
 * keyed by [Capability]; each value is a [CopyOnWriteArrayList] of
 * provider names so iteration during reads doesn't block writers and
 * `advertise` doesn't see torn reads.
 *
 * `advertise` is idempotent for `(capability, providerName)` pairs —
 * registering the same provider twice for the same capability does
 * not create a duplicate entry in [providers].
 */
class DefaultCapabilityRegistry : CapabilityRegistry {

    private val map: MutableMap<Capability, CopyOnWriteArrayList<String>> = ConcurrentHashMap()

    override fun has(capability: Capability): Boolean =
        map[capability]?.isNotEmpty() == true

    override fun providers(capability: Capability): List<String> =
        map[capability]?.toList() ?: emptyList()

    override fun advertise(capability: Capability, providerName: String) {
        val list = map.computeIfAbsent(capability) { CopyOnWriteArrayList() }
        list.addIfAbsent(providerName)
    }

    override fun all(): Map<Capability, List<String>> =
        map.mapValues { (_, list) -> list.toList() }
}
