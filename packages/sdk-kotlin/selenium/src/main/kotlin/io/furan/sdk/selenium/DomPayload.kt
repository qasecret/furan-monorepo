package io.furan.sdk.selenium

/**
 * Tier 2.2 precedence for the per-checkpoint DOM payload:
 *
 *   1. explicit [override] (caller passed `CheckpointOptions.domHtml`)
 *      → always wins, regardless of [sendDom]
 *   2. [sendDom] = false → return null without invoking [capture]
 *   3. [sendDom] = true (default) → call [capture]; on null or thrown
 *      from the capturer return null (matches the pre-existing
 *      `runCatching { … }.getOrNull()` semantics — DOM capture failing
 *      must never block the screenshot upload)
 */
internal inline fun resolveDomPayload(
    override: String?,
    sendDom: Boolean,
    capture: () -> String?,
): String? {
    if (override != null) return override
    if (!sendDom) return null
    return runCatching { capture() }.getOrNull()
}
