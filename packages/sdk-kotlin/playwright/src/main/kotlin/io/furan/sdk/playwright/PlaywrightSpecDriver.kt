package io.furan.sdk.playwright

import com.microsoft.playwright.ElementHandle
import com.microsoft.playwright.Page
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Rect
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import kotlin.math.roundToInt

/**
 * The Playwright-Java implementation of [SpecDriver]. All capture logic lives
 * in the core CaptureEngine; this only adapts the primitives.
 *
 * API notes (Playwright-Java 1.49.0): `viewportSize()`, `boundingBox()`, and
 * `BrowserContext.browser()` can each return null at runtime — no explicit
 * viewport, a detached/invisible element, and a browserless context
 * respectively. A null `viewportSize()` means the context renders at the OS
 * window size, so RESIZE_VIEWPORT is withheld (the engine then skips the resize
 * that `page.setViewportSize()` would otherwise force on / fail against it).
 * Screenshot overloads return bare `byte[]` (Kotlin `ByteArray`); no Options
 * wrapper is needed for the default (viewport / element) behaviour.
 */
class PlaywrightSpecDriver(private val page: Page) : SpecDriver {

    override fun getDriverInfo(): DriverInfo = DriverInfo(
        isNative = false,
        isMobile = false,
        browserName = page.context().browser()?.browserType()?.name()
            ?.takeIf { it.isNotBlank() }
            ?.lowercase(),
        features = buildSet {
            add(Feature.JAVASCRIPT)
            add(Feature.DOM_SNAPSHOT)
            add(Feature.ELEMENT_SCREENSHOT)
            // Advertise viewport resize only when the page actually has a
            // settable viewport. A viewport=null context renders at the OS
            // window size and page.setViewportSize() would override (or throw
            // on) it — so the engine must skip the resize and capture natural.
            if (page.viewportSize() != null) add(Feature.RESIZE_VIEWPORT)
        },
    )

    override fun takeScreenshot(): ByteArray = page.screenshot()

    override fun executeScript(script: String, vararg args: Any?): Any? =
        page.evaluate(wrapScript(script), args.toList())

    override fun setViewportSize(size: Size) = page.setViewportSize(size.width, size.height)

    override fun findElement(selector: Selector): SpecElement? {
        // querySelector(String) is a default method in Page; returns nullable ElementHandle.
        val handle: ElementHandle? = page.querySelector(playwrightSelector(selector))
        return handle?.let { PlaywrightSpecElement(it) }
    }
}

/** Translate a Furan [Selector] to a Playwright selector string. */
internal fun playwrightSelector(selector: Selector): String = when (selector) {
    is Selector.Css -> selector.value
    is Selector.Xpath -> "xpath=" + selector.value
    is Selector.AccessibilityId ->
        error("Playwright (web) has no accessibility-id locator; use Selector.Css or Selector.Xpath")
}

private class PlaywrightSpecElement(private val handle: ElementHandle) : SpecElement {
    override fun boundingRect(): Rect {
        // boundingBox() returns null for a detached or invisible element.
        val b = handle.boundingBox() ?: return Rect(0, 0, 0, 0)
        return Rect(b.x.roundToInt(), b.y.roundToInt(), b.width.roundToInt(), b.height.roundToInt())
    }

    override fun elementScreenshot(): ByteArray = handle.screenshot()
}
