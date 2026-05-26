package io.furan.sdk.endpoint

import java.util.concurrent.ConcurrentHashMap
import kotlin.time.ExperimentalTime
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/**
 * Decorator that wraps an inner [EndpointResolver] and tracks which
 * endpoints have recently failed. Callers (the HTTP transport, in a
 * future phase — or the test suite, today) signal failures via
 * [markFailed]; the next [resolve] call promotes the first non-failed
 * fallback to primary.
 *
 * Demotion is time-bounded: each failure marks the endpoint as
 * unavailable for [demoteWindow] (default 30 seconds). After the
 * window elapses, the endpoint becomes eligible again on the next
 * resolve.
 *
 * If every known endpoint is currently demoted, [resolve] returns the
 * inner resolver's primary unchanged with empty fallbacks — a
 * last-resort path rather than throwing. Callers can detect this case
 * (all-demoted) by observing that the returned primary is in their
 * own most-recent failed list, if they need to surface a system-wide
 * outage rather than blindly retry.
 *
 * Thread-safety: failure tracking is backed by [ConcurrentHashMap].
 * Multiple coroutines may call [markFailed] and [resolve] concurrently.
 */
@OptIn(ExperimentalTime::class)
class FailoverEndpointResolver(
    private val inner: EndpointResolver,
    private val demoteWindow: Duration = 30.seconds,
    private val timeSource: TimeSource = TimeSource.Monotonic,
) : EndpointResolver {

    init {
        require(demoteWindow > Duration.ZERO) {
            "FailoverEndpointResolver.demoteWindow must be > 0"
        }
    }

    /** url → mark taken at the moment of [markFailed]. Pruned lazily on resolve. */
    private val demoted: MutableMap<String, TimeMark> = ConcurrentHashMap()

    /** Record that [url] failed. Demotes it from the active rotation
     *  for [demoteWindow] from now. Idempotent across repeated calls
     *  — each call refreshes the demote window. */
    fun markFailed(url: String) {
        demoted[url] = timeSource.markNow()
    }

    override suspend fun resolve(hint: EndpointHint): ResolvedEndpoint {
        val base = inner.resolve(hint)
        pruneExpired()

        val allCandidates = listOf(base.primary) + base.fallbacks
        val active = allCandidates.filterNot { demoted.containsKey(it) }

        return if (active.isEmpty()) {
            // Everyone is demoted — return the inner primary as a
            // last resort with no fallbacks (caller decides what to do).
            ResolvedEndpoint(
                primary = base.primary,
                fallbacks = emptyList(),
                ttl = base.ttl,
                source = "${SOURCE_PREFIX}[${base.source}]",
            )
        } else {
            ResolvedEndpoint(
                primary = active.first(),
                fallbacks = active.drop(1),
                ttl = base.ttl,
                source = "${SOURCE_PREFIX}[${base.source}]",
            )
        }
    }

    private fun pruneExpired() {
        val iterator = demoted.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.value.elapsedNow() >= demoteWindow) {
                iterator.remove()
            }
        }
    }

    private companion object {
        const val SOURCE_PREFIX: String = "failover"
    }
}
