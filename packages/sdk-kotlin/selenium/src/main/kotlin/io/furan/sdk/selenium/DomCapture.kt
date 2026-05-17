package io.furan.sdk.selenium

import org.openqa.selenium.JavascriptExecutor
import org.openqa.selenium.WebDriver

/**
 * Captures the rendered DOM of the current page as a serialized HTML string.
 * Uses `document.documentElement.outerHTML` — captures the post-JS-render state,
 * which is what users actually see and what the diff engine should compare.
 */
internal fun captureDom(driver: WebDriver): String {
    val executor = driver as? JavascriptExecutor
        ?: error("WebDriver does not implement JavascriptExecutor; cannot capture DOM")
    return (executor.executeScript("return document.documentElement.outerHTML") as? String).orEmpty()
}
