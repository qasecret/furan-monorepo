package io.furan.sdk.dto

import kotlinx.serialization.Serializable

@Serializable
data class Region(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
)

@Serializable
data class FloatingRegion(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val maxUpOffset: Double = 0.0,
    val maxDownOffset: Double = 0.0,
    val maxLeftOffset: Double = 0.0,
    val maxRightOffset: Double = 0.0,
)

@Serializable
enum class AccessibilityType {
    LargeText, RegularText, BoldText, GraphicalObject
}

@Serializable
data class AccessibilityRegion(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val type: AccessibilityType,
)
