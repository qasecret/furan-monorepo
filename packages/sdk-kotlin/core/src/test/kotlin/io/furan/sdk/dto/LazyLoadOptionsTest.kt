package io.furan.sdk.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class LazyLoadOptionsTest {

    @Test
    fun `has sensible defaults`() {
        val o = LazyLoadOptions()
        assertEquals(300, o.scrollLength)
        assertEquals(200L, o.waitingTimeMs)
        assertEquals(15_000, o.maxAmountToScroll)
    }

    @Test
    fun `scrollLength must be positive`() {
        assertThrows(IllegalArgumentException::class.java) { LazyLoadOptions(scrollLength = 0) }
        assertThrows(IllegalArgumentException::class.java) { LazyLoadOptions(scrollLength = -5) }
    }

    @Test
    fun `waitingTimeMs must be non-negative — zero is allowed`() {
        // Zero is allowed (fastest mode — for tests that just want
        // step-scroll without a pause).
        LazyLoadOptions(waitingTimeMs = 0)
        assertThrows(IllegalArgumentException::class.java) { LazyLoadOptions(waitingTimeMs = -1) }
    }

    @Test
    fun `maxAmountToScroll must be positive`() {
        assertThrows(IllegalArgumentException::class.java) { LazyLoadOptions(maxAmountToScroll = 0) }
        assertThrows(IllegalArgumentException::class.java) { LazyLoadOptions(maxAmountToScroll = -100) }
    }
}
