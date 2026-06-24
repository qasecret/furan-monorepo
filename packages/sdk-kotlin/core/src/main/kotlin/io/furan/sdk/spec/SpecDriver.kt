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
     * Evaluate [script] and return a JSON-compatible value (String / number /
     * Boolean / List / Map / null). Only called when [DriverInfo.features]
     * contains [Feature.JAVASCRIPT].
     *
     * Engine scripts use the JS-executor (Selenium) dialect: the body may use a
     * top-level `return` to yield a value and `arguments[0..n]` to read the
     * positional [args]. An adapter whose native eval does not match that shape
     * (e.g. Playwright's function-wrapping `page.evaluate`) MUST translate it —
     * see furan-playwright's `wrapScript`. Numbers may arrive as Long (Selenium)
     * or Integer/Double (Playwright); read them as [Number].
     */
    fun executeScript(script: String, vararg args: Any?): Any?

    /** Only called when [DriverInfo.features] contains [Feature.RESIZE_VIEWPORT]. */
    fun setViewportSize(size: Size)

    /** Locate one element, or null when the selector matches nothing. */
    fun findElement(selector: Selector): SpecElement?
}

/** A located element: its current rect, and its pixels (element-direct capture). */
interface SpecElement {
    fun boundingRect(): Rect
    fun elementScreenshot(): ByteArray
}
