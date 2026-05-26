package io.furan.sdk.diagnostics

/**
 * Lightweight snapshot of JVM heap usage at the moment of
 * `MemoryStats.snapshot()`. Values are in bytes.
 *
 * Reading is non-blocking and cheap — backed by [Runtime.getRuntime].
 * No GC instrumentation, no managed-bean queries; this is operator-
 * grade visibility, not a profiler.
 */
data class MemoryStats(
    val heapUsedBytes: Long,
    val heapCommittedBytes: Long,
    val heapMaxBytes: Long,
) {
    companion object {
        fun snapshot(): MemoryStats {
            val rt = Runtime.getRuntime()
            val total = rt.totalMemory()
            val free = rt.freeMemory()
            val max = rt.maxMemory()
            return MemoryStats(
                heapUsedBytes = total - free,
                heapCommittedBytes = total,
                heapMaxBytes = max,
            )
        }
    }
}
