package io.furan.sdk.capture

import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement

/**
 * Configurable, call-recording [SpecDriver] test double. Tests drive
 * behavior via the lambdas and assert against the recorded calls. The
 * default [driverInfo] is a fully web-capable driver.
 */
class FakeSpecDriver(
    private val driverInfo: DriverInfo = DriverInfo(
        browserName = "fake",
        features = setOf(
            Feature.JAVASCRIPT, Feature.DOM_SNAPSHOT,
            Feature.RESIZE_VIEWPORT, Feature.ELEMENT_SCREENSHOT,
        ),
    ),
    private val onTakeScreenshot: () -> ByteArray = { ByteArray(0) },
    private val onExecuteScript: (script: String, args: Array<out Any?>) -> Any? = { _, _ -> null },
    private val elements: Map<String, SpecElement> = emptyMap(),
    private val onFindElement: ((Selector) -> SpecElement?)? = null,
) : SpecDriver {
    val executedScripts = mutableListOf<String>()
    val setViewportCalls = mutableListOf<Size>()
    var screenshotCount = 0
        private set

    override fun getDriverInfo(): DriverInfo = driverInfo

    override fun takeScreenshot(): ByteArray {
        screenshotCount++
        return onTakeScreenshot()
    }

    override fun executeScript(script: String, vararg args: Any?): Any? {
        executedScripts.add(script)
        return onExecuteScript(script, args)
    }

    override fun setViewportSize(size: Size) {
        setViewportCalls.add(size)
    }

    override fun findElement(selector: Selector): SpecElement? {
        onFindElement?.let { return it(selector) }
        val key = when (selector) {
            is Selector.Css -> selector.value
            is Selector.Xpath -> selector.value
            is Selector.AccessibilityId -> selector.value
        }
        return elements[key]
    }
}

/** A canned [SpecElement] for region/element-capture tests. */
class FakeSpecElement(
    private val rect: Rect,
    private val png: ByteArray = ByteArray(0),
) : SpecElement {
    override fun boundingRect(): Rect = rect
    override fun elementScreenshot(): ByteArray = png
}
