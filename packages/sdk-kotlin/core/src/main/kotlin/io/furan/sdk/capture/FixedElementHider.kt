package io.furan.sdk.capture

import io.furan.sdk.spec.SpecDriver

/**
 * The id of the injected `<style>` element. Stable so [removeFixedElementHider]
 * can find it. Picked unlikely to collide with any user style id.
 */
internal const val FIXED_HIDE_STYLE_ID: String = "__furan_fixed_hide"

/**
 * Tier 3 (full-page stitching support): inject a `<style>` element that
 * hides every selector in [selectors] for the duration of the stitch.
 * Restore via [removeFixedElementHider] in a finally block.
 *
 * Selectors arrive from user-controlled config (CheckpointOptions), so
 * the assembled CSS rule is passed as `arguments[0]` to the script body
 * rather than interpolated into the script source. That keeps a
 * quote-bearing, brace-bearing, or otherwise hostile selector from
 * breaking out of the JS string literal and executing arbitrary JS.
 */
internal fun injectFixedElementHider(driver: SpecDriver, selectors: List<String>) {
    if (selectors.isEmpty()) return
    val joined = selectors.joinToString(",")
    val css = "$joined{display:none !important}"
    driver.executeScript(
        """
        (function(css){
            var s = document.createElement('style');
            s.id = '$FIXED_HIDE_STYLE_ID';
            s.textContent = css;
            document.head.appendChild(s);
        })(arguments[0]);
        """.trimIndent(),
        css,
    )
}

/**
 * Remove the `<style>` element injected by [injectFixedElementHider].
 * Safe to call even when no hider was injected (the JS no-ops if the
 * element is missing).
 */
internal fun removeFixedElementHider(driver: SpecDriver) {
    driver.executeScript(
        """
        (function(){
            var s = document.getElementById('$FIXED_HIDE_STYLE_ID');
            if (s) s.remove();
        })();
        """.trimIndent(),
    )
}
