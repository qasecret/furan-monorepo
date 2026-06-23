package io.furan.sdk.spec

/**
 * Driver-agnostic element locator. Each adapter translates these to its
 * native query type (Selenium `By`, Playwright `Locator`, Appium `AppiumBy`).
 * [AccessibilityId] is for Appium-native; web adapters reject it.
 */
sealed interface Selector {
    data class Css(val value: String) : Selector
    data class Xpath(val value: String) : Selector
    data class AccessibilityId(val value: String) : Selector
}
