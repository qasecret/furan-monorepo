package io.furan.sdk.capture

import io.furan.sdk.dto.LazyLoadOptions
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Tier 2.1 — exercises the scroll-loop semantics via FakeSpecDriver that
 * records every executeScript call. We don't need a real browser to
 * verify the algorithm: stop conditions (scrollHeight reached,
 * maxAmountToScroll reached), step size, and restore-to-top.
 */
class LazyLoadScrollTest {

    @Test
    fun `scrolls in fixed-step increments until scrollHeight is reached`() = runTest {
        // scrollHeight = 1000, scrollLength = 300, maxAmount = 15000.
        // Expected scrollTo args: 300, 600, 900, 1200, then 0 (restore).
        val scrolledTo = mutableListOf<Int>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args ->
                when {
                    script.contains("scrollHeight") -> 1000
                    script.contains("scrollTo") -> {
                        val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                        scrolledTo.add(y)
                        null
                    }
                    else -> null
                }
            },
        )
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        assertEquals(listOf(300, 600, 900, 1200, 0), scrolledTo)
    }

    @Test
    fun `stops at maxAmountToScroll`() = runTest {
        // scrollHeight = 100000 (effectively infinite), max = 1000,
        // step = 300. Expected scrollTo args: 300, 600, 900, 1000, then
        // 0 (restore). The last step coerces to 1000 (the cap) instead
        // of 1200.
        val scrolledTo = mutableListOf<Int>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args ->
                when {
                    script.contains("scrollHeight") -> 100_000
                    script.contains("scrollTo") -> {
                        val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                        scrolledTo.add(y)
                        null
                    }
                    else -> null
                }
            },
        )
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0, maxAmountToScroll = 1000))
        assertEquals(listOf(300, 600, 900, 1000, 0), scrolledTo)
    }

    @Test
    fun `short page bails after one step`() = runTest {
        // scrollHeight = 50, step = 300. First scrollTo arg is 300
        // (coerce above scrollHeight), loop exits next iteration when
        // scrolled (300) >= scrollHeight (50). Then restore to 0.
        val scrolledTo = mutableListOf<Int>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args ->
                when {
                    script.contains("scrollHeight") -> 50
                    script.contains("scrollTo") -> {
                        val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                        scrolledTo.add(y)
                        null
                    }
                    else -> null
                }
            },
        )
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        assertEquals(listOf(300, 0), scrolledTo)
    }

    @Test
    fun `restores scrollY to 0 even when scrollHeight ends the loop early`() = runTest {
        val scrolledTo = mutableListOf<Int>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args ->
                when {
                    script.contains("scrollHeight") -> 600
                    script.contains("scrollTo") -> {
                        val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                        scrolledTo.add(y)
                        null
                    }
                    else -> null
                }
            },
        )
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 300, waitingTimeMs = 0))
        // Last entry MUST be 0 — the restore-to-top step.
        assertTrue(scrolledTo.isNotEmpty())
        assertEquals(0, scrolledTo.last())
    }

    @Test
    fun `dynamic scrollHeight that grows during scroll keeps stepping until max`() = runTest {
        // Simulate infinite-scroll feed: every read of scrollHeight is
        // 1.5x the current scroll position, so the bound runs away. Only
        // maxAmountToScroll terminates the loop.
        // Expected scrollTo args under max=800: 200, 400, 600, 800, then 0.
        val scrolledTo = mutableListOf<Int>()
        var currentScroll = 0
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args ->
                when {
                    script.contains("scrollHeight") -> ((currentScroll + 100) * 1.5).toInt()
                    script.contains("scrollTo") -> {
                        val y = if (args.isNotEmpty()) (args[0] as Number).toInt() else 0
                        scrolledTo.add(y)
                        currentScroll = y
                        null
                    }
                    else -> null
                }
            },
        )
        runLazyLoadScroll(driver, LazyLoadOptions(scrollLength = 200, waitingTimeMs = 0, maxAmountToScroll = 800))
        assertEquals(listOf(200, 400, 600, 800, 0), scrolledTo)
    }
}
