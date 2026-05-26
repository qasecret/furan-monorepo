package io.furan.sdk.diagnostics

/**
 * Operator-facing view onto a running [io.furan.sdk.runtime.FuranRuntime].
 *
 * The single method [snapshot] composes a [RuntimeSnapshot] at the
 * moment of the call — no caching, no background work, no async
 * suspension. Suitable for synchronous actuator endpoints, CLI dump
 * helpers, and support-ticket attachments.
 */
interface RuntimeDiagnostics {
    fun snapshot(): RuntimeSnapshot
}
