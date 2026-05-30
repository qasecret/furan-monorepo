package io.furan.sdk.selenium

import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.selenium.FixedElementHider")

/**
 * The id of the injected `<style>` element. Stable so [removeFixedElementHider]
 * can find it. Picked unlikely to collide with any user style id.
 */
internal const val FIXED_HIDE_STYLE_ID: String = "__furan_fixed_hide"

/**
 * CSS-escape characters that are meaningful at the CSS rule level ({, }, :)
 * within a raw selector string. This prevents a malicious selector value from
 * injecting extra CSS declarations when the assembled rule is embedded in the
 * script source.
 *
 * Valid pseudo-class colons (e.g. `:hover`) are also escaped — callers that
 * need pseudo-class selectors should pass them after verifying they are safe.
 * The escape is the standard CSS identifier escape (backslash + character).
 */
private fun cssEscapeSelector(selector: String): String =
    selector
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace(":", "\\:")

/**
 * Tier 3 (full-page stitching support): inject a `<style>` element that
 * hides every selector in [selectors] for the duration of the stitch.
 * Restore via [removeFixedElementHider] in a finally block.
 *
 * Each selector is CSS-escaped before being assembled into the rule to
 * prevent a quote-bearing or brace-bearing selector from injecting
 * additional CSS declarations. The final CSS string is then embedded in
 * the script source; since the selectors no longer contain raw `{`, `}`,
 * or `:` characters they cannot break out of the rule boundary.
 *
 * No-op when [selectors] is empty or when the driver is not a
 * [JavascriptExecutor]. The latter would only happen with a non-browser
 * stub; we tolerate it for parity with the rest of the SDK.
 */
internal fun injectFixedElementHider(driver: WebDriver, selectors: List<String>) {
    if (selectors.isEmpty()) return
    val js = driver as? JavascriptExecutor ?: run {
        log.debug("driver is not a JavascriptExecutor; skipping fixed-element hide")
        return
    }
    val escaped = selectors.joinToString(",") { cssEscapeSelector(it) }
    val css = "$escaped{display:none !important}"
    js.executeScript(
        """
        (function(){
            var s = document.createElement('style');
            s.id = '$FIXED_HIDE_STYLE_ID';
            s.textContent = '$css';
            document.head.appendChild(s);
        })();
        """.trimIndent(),
    )
}

/**
 * Remove the `<style>` element injected by [injectFixedElementHider].
 * Safe to call even when no hider was injected (the JS no-ops if the
 * element is missing).
 */
internal fun removeFixedElementHider(driver: WebDriver) {
    val js = driver as? JavascriptExecutor ?: run {
        log.debug("driver is not a JavascriptExecutor; skipping fixed-element restore")
        return
    }
    js.executeScript(
        """
        (function(){
            var s = document.getElementById('$FIXED_HIDE_STYLE_ID');
            if (s) s.remove();
        })();
        """.trimIndent(),
    )
}
