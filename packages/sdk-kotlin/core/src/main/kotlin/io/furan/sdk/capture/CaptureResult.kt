package io.furan.sdk.capture

import io.furan.sdk.Regions

/**
 * Everything the capture step computes for one checkpoint, ready to hand to
 * FuranClient.createScreenshot. Match-level, ignore-displacements, and the
 * accessibility levels are NOT here — they pass through from options
 * untouched by capture.
 *
 * This is a transient carrier: it is created, used once, and discarded. Its
 * [pngBytes] field is a `ByteArray`, so `equals`/`hashCode` are
 * identity-based (the `data class` generated implementations are NOT
 * value-based for arrays). Do not compare instances by equality.
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
