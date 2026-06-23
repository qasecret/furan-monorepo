package io.furan.sdk.capture

import io.furan.sdk.Regions

/**
 * Everything the capture step computes for one checkpoint, ready to hand to
 * FuranClient.createScreenshot. Match-level, ignore-displacements, and the
 * accessibility levels are NOT here — they pass through from options
 * untouched by capture.
 */
data class CaptureResult(
    val pngBytes: ByteArray,
    val viewport: String,
    val browser: String?,
    val os: String?,
    val device: String?,
    val regions: Regions,
    val domHtml: String?,
    val elementMapJson: String?,
)
