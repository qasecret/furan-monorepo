package io.furan.sdk.spec

/**
 * Runtime capability + environment advertisement, queried by the
 * CaptureEngine per capture so a context-switching driver (e.g. Appium
 * webview ⇄ native) reports the live truth. The platform/device/browser
 * fields feed the ADR-054 baseline environment tuple — the adapter owns
 * those labels; the engine never invents them.
 */
data class DriverInfo(
    val isNative: Boolean = false,
    val isMobile: Boolean = false,
    val platformName: String? = null,
    val deviceName: String? = null,
    val browserName: String? = null,
    val browserVersion: String? = null,
    val features: Set<Feature> = emptySet(),
)

/** Capabilities the engine gates capture steps on. */
enum class Feature {
    /** Driver can evaluate JavaScript (stitch, scroll, DOM, element-map). */
    JAVASCRIPT,

    /** Driver can return a serialized DOM snapshot (implies JAVASCRIPT). */
    DOM_SNAPSHOT,

    /** Driver can resize the viewport (desktop web; mobile is fixed). */
    RESIZE_VIEWPORT,

    /** Driver can capture a single element's pixels directly. */
    ELEMENT_SCREENSHOT,

    /** Driver can resolve native (non-DOM) element rects (Appium native). */
    NATIVE_ELEMENTS,
}
