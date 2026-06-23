package io.furan.sdk.playwright

/**
 * Wrap an engine script (Selenium executeScript dialect: `return …;`,
 * `arguments[0]`, side-effecting IIFEs) so Playwright's `page.evaluate` runs
 * it as a function called with the args array. Naming the single arrow param
 * `arguments` makes `arguments[0]` resolve and `return` work; arrow functions
 * have no native `arguments` object, so the name is free to reuse.
 */
internal fun wrapScript(script: String): String = "(arguments) => { $script }"

/** Baseline browser label for the env tuple: `playwright-<type>` (or `playwright`). */
internal fun playwrightBrowserLabel(browserType: String?): String =
    if (browserType.isNullOrBlank()) "playwright" else "playwright-$browserType"
