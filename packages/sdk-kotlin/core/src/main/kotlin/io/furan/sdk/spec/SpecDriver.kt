package io.furan.sdk.spec

/**
 * The capture primitive set every framework adapter implements. The
 * CaptureEngine owns all injected JavaScript and all image logic; an
 * adapter only evaluates JS, grabs bytes, sizes the viewport, and locates
 * elements. Keep this interface minimal — new capture features belong in
 * the engine, not here.
 */
interface SpecDriver {
    /** Runtime capability + environment advertisement. */
    fun getDriverInfo(): DriverInfo

    /** Viewport-sized screenshot as PNG bytes. */
    fun takeScreenshot(): ByteArray

    /**
     * Evaluate [script], returning a JSON-compatible value
     * (String/Long/Double/Boolean/List/Map/null). Only called when
     * [DriverInfo.features] contains [Feature.JAVASCRIPT].
     */
    fun executeScript(script: String, vararg args: Any?): Any?

    fun getViewportSize(): Size

    /** Only called when [DriverInfo.features] contains [Feature.RESIZE_VIEWPORT]. */
    fun setViewportSize(size: Size)

    /** Locate one element, or null when the selector matches nothing. */
    fun findElement(selector: Selector): SpecElement?

    /** Navigate the driver. Default no-op for drivers that can't (raw/native). */
    fun navigate(url: String) {}
}

/** A located element: its current rect, and its pixels (element-direct capture). */
interface SpecElement {
    fun boundingRect(): Rect
    fun elementScreenshot(): ByteArray
}
