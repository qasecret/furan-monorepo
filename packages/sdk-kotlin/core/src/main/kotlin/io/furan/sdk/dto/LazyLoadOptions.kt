package io.furan.sdk.dto

/**
 * Eyes-parity per-checkpoint lazy-load options. Mirrors
 * `eyes.check(name, { lazyLoad: { scrollLength, waitingTime, maxAmountToScroll } })`.
 *
 * When non-null on [CheckpointOptions], the Selenium adapter
 * programmatically scrolls the page in fixed-step increments — each
 * step pauses for [waitingTimeMs] so lazy-loaded content (images,
 * virtualized lists, infinite-scroll feeds) has time to render — then
 * scrolls back to the top before capturing.
 *
 * Defaults match Applitools' published defaults (300px / 200ms / 15000px),
 * which cover the common "blog post with below-the-fold images" case.
 * Tune [maxAmountToScroll] up for tall pages; set [waitingTimeMs] higher
 * for network-bound lazy loaders.
 */
data class LazyLoadOptions(
    /** Pixels to scroll per step. Must be > 0. */
    val scrollLength: Int = 300,
    /** Pause between steps so lazy-loaded content has time to render. */
    val waitingTimeMs: Long = 200,
    /**
     * Total pixels to scroll before stopping. The SDK stops early if it
     * reaches the document's `scrollHeight` first. Set high enough that
     * the full page is exercised, but not so high that a runaway
     * infinite-scroll feed loops forever.
     */
    val maxAmountToScroll: Int = 15_000,
) {
    init {
        require(scrollLength > 0) { "scrollLength must be > 0, got $scrollLength" }
        require(waitingTimeMs >= 0) { "waitingTimeMs must be >= 0, got $waitingTimeMs" }
        require(maxAmountToScroll > 0) { "maxAmountToScroll must be > 0, got $maxAmountToScroll" }
    }
}
