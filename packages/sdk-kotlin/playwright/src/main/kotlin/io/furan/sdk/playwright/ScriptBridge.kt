package io.furan.sdk.playwright

/**
 * Wrap an engine script (Selenium executeScript dialect: top-level `return`,
 * `arguments[0..n]`, side-effecting IIFEs) so Playwright's `page.evaluate` runs
 * it as a function called with the args array.
 *
 * The body runs inside an ordinary inner function invoked via `.apply(null, a)`,
 * so the script's `arguments[0..n]` resolve against that function's own native
 * `arguments` object and its top-level `return` yields the value. Relying on the
 * native `arguments` (rather than naming a parameter `arguments`) keeps the
 * wrapper valid even under strict-mode evaluation, where `arguments` is not a
 * legal parameter or binding name.
 */
internal fun wrapScript(script: String): String =
    "(a) => { return (function() { $script }).apply(null, a); }"

/** Baseline browser label for the env tuple: `playwright-<type>` (or `playwright`). */
internal fun playwrightBrowserLabel(browserType: String?): String =
    if (browserType.isNullOrBlank()) "playwright" else "playwright-$browserType"
