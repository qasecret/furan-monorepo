package io.furan.sdk.images

import io.furan.sdk.dto.AccessibilitySettings
import io.furan.sdk.dto.Region
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ImageCheckpointResolverTest {

    private val image = NormalizedImage(byteArrayOf(1, 2, 3), width = 800, height = 600)

    @Test
    fun `viewport defaults to image dimensions`() {
        val r = ImageCheckpointResolver.resolve("home", ImageCheckpointOptions(), image)
        assertEquals("800x600", r.viewport)
    }

    @Test
    fun `explicit viewport overrides image dimensions`() {
        val r = ImageCheckpointResolver.resolve("home", ImageCheckpointOptions(viewport = "375x812"), image)
        assertEquals("375x812", r.viewport)
    }

    @Test
    fun `browser defaults to image and labels pass through`() {
        val def = ImageCheckpointResolver.resolve("home", ImageCheckpointOptions(), image)
        assertEquals("image", def.browser)

        val labeled = ImageCheckpointResolver.resolve(
            "home",
            ImageCheckpointOptions(browser = "appium-ios", os = "iOS 17", device = "iPhone 15"),
            image,
        )
        assertEquals("appium-ios", labeled.browser)
        assertEquals("iOS 17", labeled.os)
        assertEquals("iPhone 15", labeled.device)
    }

    @Test
    fun `regions map across kinds, accessibility empty, elementMap null`() {
        val r = ImageCheckpointResolver.resolve(
            "home",
            ImageCheckpointOptions(ignoreRegions = listOf(Region(1.0, 2.0, 3.0, 4.0))),
            image,
        )
        assertEquals(1, r.regions.ignore.size)
        assertTrue(r.regions.accessibility.isEmpty())
        assertNull(r.elementMapJson)
        assertNull(r.domHtml)
    }

    @Test
    fun `accessibility settings map to wire strings`() {
        val r = ImageCheckpointResolver.resolve(
            "home",
            ImageCheckpointOptions(
                accessibilitySettings = AccessibilitySettings(),
                domHtml = "<html></html>",
            ),
            image,
        )
        assertEquals("AA", r.accessibilityLevel)
        assertEquals("WCAG_2_1", r.accessibilityVersion)
    }

    @Test
    fun `domHtml passes through to the resolved checkpoint`() {
        val r = ImageCheckpointResolver.resolve(
            "home",
            ImageCheckpointOptions(domHtml = "<html><body>hi</body></html>"),
            image,
        )
        assertEquals("<html><body>hi</body></html>", r.domHtml)
    }

    @Test
    fun `accessibilitySettings without domHtml is rejected`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            ImageCheckpointResolver.resolve(
                "home",
                ImageCheckpointOptions(accessibilitySettings = AccessibilitySettings()),
                image,
            )
        }
        assertTrue(ex.message!!.contains("domHtml"))
    }

    @Test
    fun `selector-bearing region is rejected`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            ImageCheckpointResolver.resolve(
                "home",
                ImageCheckpointOptions(ignoreRegions = listOf(Region.bySelector(".dynamic"))),
                image,
            )
        }
        assertTrue(ex.message!!.contains("selector"))
    }
}
