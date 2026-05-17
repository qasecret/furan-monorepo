package io.furan.sdk.transport

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class RetryTest {
    @Test
    fun `succeeds on first attempt`() = runTest {
        var attempts = 0
        val result = withRetry { attempts++; "ok" }
        assertEquals("ok", result)
        assertEquals(1, attempts)
    }

    @Test
    fun `retries up to maxAttempts on retriable error`() = runTest {
        var attempts = 0
        assertThrows<RetriableException> {
            withRetry(RetryPolicy(maxAttempts = 3, baseDelayMs = 1, jitter = 0.0)) {
                attempts++
                throw RetriableException("transient $attempts")
            }
        }
        assertEquals(3, attempts)
    }

    @Test
    fun `does not retry on non-retriable error`() = runTest {
        var attempts = 0
        assertThrows<IllegalArgumentException> {
            withRetry(RetryPolicy(maxAttempts = 5, baseDelayMs = 1)) {
                attempts++
                throw IllegalArgumentException("permanent")
            }
        }
        assertEquals(1, attempts)
    }

    @Test
    fun `returns result after one retry`() = runTest {
        var attempts = 0
        val result = withRetry(RetryPolicy(maxAttempts = 3, baseDelayMs = 1, jitter = 0.0)) {
            attempts++
            if (attempts == 1) throw RetriableException("transient")
            "success"
        }
        assertEquals("success", result)
        assertEquals(2, attempts)
    }
}
