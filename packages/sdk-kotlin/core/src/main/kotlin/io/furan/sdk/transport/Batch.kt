package io.furan.sdk.transport

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Simple buffered batcher. When the buffer reaches `size`, the [flushFn] is invoked
 * with the accumulated items and the buffer is reset. Call [flush] manually to drain
 * an incomplete batch (e.g., on client close).
 */
class Batch<T>(
    private val size: Int,
    private val flushFn: suspend (List<T>) -> Unit,
) {
    private val buffer = mutableListOf<T>()
    private val mutex = Mutex()

    suspend fun offer(item: T) {
        val toFlush: List<T>? = mutex.withLock {
            buffer.add(item)
            if (buffer.size >= size) {
                val copy = buffer.toList()
                buffer.clear()
                copy
            } else null
        }
        if (toFlush != null) flushFn(toFlush)
    }

    suspend fun flush() {
        val toFlush: List<T>? = mutex.withLock {
            if (buffer.isEmpty()) null
            else {
                val copy = buffer.toList()
                buffer.clear()
                copy
            }
        }
        if (toFlush != null) flushFn(toFlush)
    }
}
