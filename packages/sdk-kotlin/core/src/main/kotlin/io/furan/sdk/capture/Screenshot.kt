package io.furan.sdk.capture

import io.furan.sdk.spec.SpecDriver

/** Captures a viewport-sized screenshot as PNG bytes via the SPI. */
internal fun captureScreenshot(driver: SpecDriver): ByteArray = driver.takeScreenshot()
