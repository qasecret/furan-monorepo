package io.furan.sdk.transport

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BatchTest {
    @Test
    fun `flushes at size threshold`() = runTest {
        val flushed = mutableListOf<List<Int>>()
        val batch = Batch<Int>(size = 3) { flushed.add(it) }
        batch.offer(1); batch.offer(2)
        assertTrue(flushed.isEmpty())
        batch.offer(3)
        assertEquals(listOf(listOf(1, 2, 3)), flushed)
    }

    @Test
    fun `manual flush drains incomplete batch`() = runTest {
        val flushed = mutableListOf<List<Int>>()
        val batch = Batch<Int>(size = 10) { flushed.add(it) }
        batch.offer(1); batch.offer(2)
        batch.flush()
        assertEquals(listOf(listOf(1, 2)), flushed)
    }

    @Test
    fun `manual flush on empty buffer is no-op`() = runTest {
        val flushed = mutableListOf<List<Int>>()
        val batch = Batch<Int>(size = 10) { flushed.add(it) }
        batch.flush()
        assertTrue(flushed.isEmpty())
    }
}
