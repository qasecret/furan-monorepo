package io.furan.sdk.playwright

import io.furan.sdk.spec.Selector
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class PlaywrightSelectorTest {
    @Test fun `css passes through`() {
        assertEquals(".btn", playwrightSelector(Selector.Css(".btn")))
    }
    @Test fun `xpath gets the playwright xpath= prefix`() {
        assertEquals("xpath=//a[@id='x']", playwrightSelector(Selector.Xpath("//a[@id='x']")))
    }
    @Test fun `accessibility-id is rejected on web`() {
        assertThrows(IllegalStateException::class.java) {
            playwrightSelector(Selector.AccessibilityId("home"))
        }
    }
}
