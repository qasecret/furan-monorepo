package io.furan.sdk.dto

/**
 * Per-checkpoint options passed to [io.furan.sdk.selenium.Furan.snapshot].
 * Carries the match level and all five region kinds (ignore, layout,
 * floating, content, accessibility) that the diff worker uses when
 * comparing this checkpoint against its baseline.
 *
 * [domHtml] and [elementMapJson] are optional side-channels for DOM/element
 * capture; when null the SDK auto-captures from the driver.
 */
data class CheckpointOptions(
    val matchLevel: MatchLevel = MatchLevel.Strict,
    val ignoreRegions: List<Region> = emptyList(),
    val layoutRegions: List<Region> = emptyList(),
    val floatingRegions: List<FloatingRegion> = emptyList(),
    val contentRegions: List<Region> = emptyList(),
    val accessibilityRegions: List<AccessibilityRegion> = emptyList(),
    /**
     * Capture only a sub-rectangle of the viewport (mirrors Applitools
     * `eyes.check(name, { region })`). When null the full viewport is
     * captured. The crop happens client-side before upload; the api +
     * diff engine see only the cropped bytes, so the baseline established
     * the first time you snapshot a region is the cropped image.
     *
     * Coordinates are in viewport-CSS pixels. Out-of-bounds regions are
     * clamped to the captured image dimensions; a fully-out-of-bounds
     * region throws [IllegalArgumentException].
     */
    val region: Region? = null,
    /**
     * Inline JavaScript to execute on the page immediately before the
     * screenshot is captured (Eyes-parity Tier 1.3, mirrors
     * `eyes.check(name, { hooks: { beforeCaptureScreenshot } })`).
     *
     * Common use cases: hiding a modal that animates in over the page,
     * pausing a video, freezing CSS animations, scrolling to top, or
     * setting input focus to a deterministic element. The hook runs
     * BEFORE [waitBeforeCaptureMs] so a JS-triggered animation has time
     * to settle.
     *
     * Silently dropped if the driver does not implement
     * `JavascriptExecutor` (would only happen with a non-browser stub).
     * A thrown JS error aborts the snapshot — the test sees the original
     * exception, not a degraded baseline.
     */
    val beforeCaptureScreenshot: String? = null,
    /**
     * Milliseconds to pause after [beforeCaptureScreenshot] (if any) and
     * before the screenshot is captured (Eyes-parity, mirrors
     * `eyes.check(name, { waitBeforeCapture })`). Defaults to 0.
     *
     * Use this when you've triggered a state change (e.g. clicked a
     * button that fires a CSS transition) and want the transition to
     * settle before capture. Prefer explicit waits in the test code when
     * possible; this knob exists for the cases where you can't wait on
     * a specific selector / condition.
     */
    val waitBeforeCaptureMs: Long = 0,
    /**
     * Eyes-parity Tier 2.3 stability budget: when > 0, the SDK
     * captures repeatedly with a short interval between samples and
     * exits as soon as two consecutive captures have identical bytes
     * (page is stable) OR the cumulative wait exceeds this value.
     *
     * Mirrors Applitools `setMatchTimeout` / `matchTimeout` semantics
     * from the user's perspective ("wait up to N ms for the page to
     * stabilize before snapshotting"), implemented client-side because
     * Furan's diff pipeline is asynchronous — the captured bytes are
     * the candidate, so the SDK has to do the stabilization, not the
     * server.
     *
     * Use this when CSS transitions, async data fetches, or web fonts
     * haven't settled at `snapshot()` time. Prefer explicit waits on a
     * specific selector when possible — this knob covers the case
     * where there's no single element to anchor on.
     *
     * Defaults to 0 (single-shot capture, no polling).
     */
    val matchTimeoutMs: Long = 0,
    /**
     * Eyes-parity Tier 2.1: lazy-load handling. When non-null, the
     * Selenium adapter scrolls the page in fixed-step increments before
     * capture (with a pause between steps) so lazy-loaded content has
     * time to render. The SDK restores the scroll position to the top
     * before snapshotting. See [LazyLoadOptions] for defaults and
     * tuning guidance.
     *
     * The scroll loop runs AFTER [beforeCaptureScreenshot] and BEFORE
     * [waitBeforeCaptureMs] — so JS-triggered DOM mutations happen
     * first, then lazy content settles, then the final pause.
     */
    val lazyLoad: LazyLoadOptions? = null,
    /**
     * When true, the diff engine drops L2 `relocateGroup` regions for
     * this checkpoint (Eyes-parity Tier 1.4, mirrors
     * `eyes.check(name, { ignoreDisplacements: true })`).
     *
     * Use this when test content predictably shifts position between
     * runs (e.g. a new banner inserted above the page body). Without
     * the flag, the DOM diff flags every shifted element as "moved";
     * with the flag, only true content changes survive.
     *
     * Pixel-level (L1) displacement detection is a separate engine
     * pass; the SDK flag persists on the screenshot row so a later L1
     * pass can read the same intent.
     */
    val ignoreDisplacements: Boolean = false,
    /**
     * Eyes-parity Tier 2.4: when true, the SDK auto-appends a
     * selector-anchored ignore region targeting the focused text
     * input — `input:focus, textarea:focus, [contenteditable]:focus` —
     * so a blinking caret doesn't flag as a diff.
     *
     * Mirrors Applitools `setIgnoreCaret` from the user's
     * perspective. Furan's implementation is selector-based and
     * masks the entire focused input (not just the caret pixels).
     * For inputs where the rest of the content also varies (e.g.
     * a username field with a username already typed), prefer an
     * explicit `ignoreRegions = listOf(Region.bySelector(".my-input"))`
     * targeting only the input you want masked.
     *
     * True sub-pixel caret detection (the Eyes engine-side
     * approach) is a future engine pass; for now this knob covers
     * the common case where a focused input is the source of
     * caret-noise diffs.
     */
    val ignoreCaret: Boolean = false,
    /**
     * Eyes-parity Tier 2.5: when set, the diff-worker runs axe-core
     * against the captured DOM snapshot and surfaces WCAG violations
     * as `diff_regions` with `source = 'axe'`,
     * `category = 'accessibility'`. See [AccessibilitySettings] for
     * level + version controls.
     *
     * Requires DOM capture (default; opt out via [sendDom] = false).
     * A checkpoint that opts in here without a DOM payload logs a
     * WARN server-side and skips the accessibility pass.
     */
    val accessibilitySettings: AccessibilitySettings? = null,
    /**
     * Eyes-parity Tier 2.2: when false, the SDK skips DOM capture
     * entirely (mirrors Applitools `setSendDom(false)`). Default is
     * true — DOM upload powers L2 (DOM/CSS) root-cause analysis, so
     * disabling it trades root-cause depth for privacy / network /
     * storage savings.
     *
     * Use cases for `sendDom = false`:
     *  - Air-gapped or regulated environments where uploading rendered
     *    HTML would leak content (PII in the rendered DOM, etc).
     *  - Static-page or image-only tests where DOM upload is pure
     *    overhead.
     *  - High-volume CI where the DOM payload (typically 50–500 KB per
     *    checkpoint) is the bottleneck.
     *
     * A `domHtml` override (next field) takes precedence: when set
     * explicitly, the SDK sends that payload regardless of [sendDom].
     */
    val sendDom: Boolean = true,
    /**
     * Optional DOM HTML override. When null AND [sendDom] is true,
     * the selenium adapter auto-captures via
     * `document.documentElement.outerHTML`. When [sendDom] is false,
     * this field is ignored unless explicitly non-null.
     */
    val domHtml: String? = null,
    /**
     * Optional pre-serialized element-bbox JSON. When null, the selenium
     * adapter auto-captures via the ELEMENT_BBOX_SCRIPT executor.
     */
    val elementMapJson: String? = null,
)
