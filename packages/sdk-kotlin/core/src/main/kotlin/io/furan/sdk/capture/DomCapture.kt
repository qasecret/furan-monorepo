package io.furan.sdk.capture

import io.furan.sdk.spec.SpecDriver

/**
 * Captures the rendered DOM (`document.documentElement.outerHTML`) — the
 * post-JS-render state the diff engine compares.
 */
internal fun captureDom(driver: SpecDriver): String =
    (driver.executeScript("return document.documentElement.outerHTML") as? String).orEmpty()
