package io.furan.sdk.dto

import kotlinx.serialization.Serializable

@Serializable
enum class MatchLevel {
    Strict, Layout, Content, IgnoreColors, Dynamic
}
