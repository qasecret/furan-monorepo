package io.furan.sdk.spec

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SpecContractTest {
    @Test
    fun `DriverInfo defaults to a non-native, featureless web driver`() {
        val info = DriverInfo()
        assertFalse(info.isNative)
        assertFalse(info.isMobile)
        assertTrue(info.features.isEmpty())
        assertEquals(null, info.browserName)
    }

    @Test
    fun `Feature enum exposes the capability set the engine gates on`() {
        assertEquals(
            setOf("JAVASCRIPT", "DOM_SNAPSHOT", "RESIZE_VIEWPORT", "ELEMENT_SCREENSHOT", "NATIVE_ELEMENTS"),
            Feature.entries.map { it.name }.toSet(),
        )
    }

    @Test
    fun `Selector is exhaustive over css, xpath, accessibility-id`() {
        val describe: (Selector) -> String = {
            when (it) {
                is Selector.Css -> "css:${it.value}"
                is Selector.Xpath -> "xpath:${it.value}"
                is Selector.AccessibilityId -> "aid:${it.value}"
            }
        }
        assertEquals("css:.a", describe(Selector.Css(".a")))
        assertEquals("xpath://a", describe(Selector.Xpath("//a")))
        assertEquals("aid:home", describe(Selector.AccessibilityId("home")))
    }
}
