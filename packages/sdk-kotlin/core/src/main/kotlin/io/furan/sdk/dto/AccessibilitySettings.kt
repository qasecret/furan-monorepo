package io.furan.sdk.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Tier 2.5 (`accessibilitySettings`): when set on
 * [CheckpointOptions], the diff-worker runs axe-core against the
 * captured DOM snapshot and surfaces WCAG violations as additional
 * `diff_regions` rows with `source = 'axe'`, `category = 'accessibility'`.
 *
 * Accepts a WCAG conformance `level` ('AA' | 'AAA') and a
 * `guidelinesVersion` ('WCAG_2_0' | 'WCAG_2_1').
 *
 * Requires that DOM capture is enabled (`sendDom != false`, default true)
 * — axe-core needs a DOM tree to run against. A checkpoint with
 * accessibilitySettings set + sendDom = false logs a WARN server-side
 * and skips the accessibility pass.
 */
@Serializable
data class AccessibilitySettings(
    val level: AccessibilityLevel = AccessibilityLevel.AA,
    val guidelinesVersion: WcagVersion = WcagVersion.WCAG_2_1,
)

/**
 * WCAG conformance level. AA is the practical default for most
 * production sites; AAA includes a small set of stricter rules
 * (e.g. text contrast ≥ 7:1 vs AA's 4.5:1).
 */
@Serializable
enum class AccessibilityLevel(val wire: String) {
    @SerialName("AA")
    AA("AA"),

    @SerialName("AAA")
    AAA("AAA"),
}

/**
 * WCAG guideline version. WCAG_2_1 is the current published standard
 * (2018) and supersets WCAG_2_0 (2008) with additional mobile +
 * cognitive-accessibility rules. WCAG_2_2 ships in 2023 — to be added
 * when axe-core's rule pack catches up.
 */
@Serializable
enum class WcagVersion(val wire: String) {
    @SerialName("WCAG_2_0")
    WCAG_2_0("WCAG_2_0"),

    @SerialName("WCAG_2_1")
    WCAG_2_1("WCAG_2_1"),
}
