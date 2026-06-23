package io.furan.sdk.capture

import io.furan.sdk.spec.SpecDriver
import kotlinx.coroutines.delay
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.capture.StableCapture")

/** How often to re-sample while waiting for stability. Small enough to detect
 * sub-second transitions, large enough that the polling cost stays bounded.
 *
 * 100ms = ~10 samples / second. For a 2000ms budget that's ~20 captures,
 * each ~50–100ms via Selenium's `TakesScreenshot` → roughly 1.0–2.0s of
 * capture work on top of the budget. Acceptable for a stability gate that
 * users opt into with a non-zero matchTimeoutMs. */
private const val SAMPLE_INTERVAL_MS = 100L

/**
 * Tier 2.3: capture the viewport, then re-capture every
 * [SAMPLE_INTERVAL_MS] until two consecutive captures have identical
 * bytes (page is stable) OR the cumulative wait reaches [timeoutMs].
 *
 * When [timeoutMs] ≤ 0, returns a single capture without polling
 * (current behavior — no overhead for callers that didn't opt in).
 *
 * Returns the most recent capture: the stable bytes when stability is
 * reached, or the last sample when the budget runs out.
 *
 * Logged at DEBUG: each sample's index + bytes length. WARN if the
 * budget exhausts without reaching stability.
 */
suspend fun captureStableScreenshot(
    driver: SpecDriver,
    timeoutMs: Long,
): ByteArray {
    val initial = captureScreenshot(driver)
    if (timeoutMs <= 0) return initial
    var previous = initial
    var elapsed = 0L
    var sampleIdx = 1
    while (elapsed < timeoutMs) {
        val remaining = timeoutMs - elapsed
        val wait = SAMPLE_INTERVAL_MS.coerceAtMost(remaining)
        delay(wait)
        elapsed += wait
        val current = captureScreenshot(driver)
        sampleIdx += 1
        log.debug("stability sample {} bytes={} elapsed={}", sampleIdx, current.size, elapsed)
        if (current.contentEquals(previous)) {
            return current
        }
        previous = current
    }
    log.warn(
        "matchTimeoutMs={} exhausted without two consecutive stable samples; using last capture (bytes={})",
        timeoutMs, previous.size,
    )
    return previous
}
