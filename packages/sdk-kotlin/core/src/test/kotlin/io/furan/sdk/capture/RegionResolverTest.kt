package io.furan.sdk.capture

import io.furan.sdk.dto.Region
import io.furan.sdk.spec.Rect
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class RegionResolverTest {
    @Test
    fun `selector-less region passes through unchanged`() {
        val driver = FakeSpecDriver(elements = emptyMap())
        val r = Region(x = 10.0, y = 20.0, width = 30.0, height = 40.0)
        assertSame(r, resolveRegion(driver, r))
    }

    @Test
    fun `selector resolves to element bbox`() {
        val driver = FakeSpecDriver(elements = mapOf(".target" to FakeSpecElement(Rect(100, 200, 80, 60))))
        val resolved = resolveRegion(driver, Region.bySelector(".target"))
        assertEquals(100.0, resolved.x)
        assertEquals(200.0, resolved.y)
        assertEquals(80.0, resolved.width)
        assertEquals(60.0, resolved.height)
        assertEquals(".target", resolved.selector)
    }

    @Test
    fun `selector miss falls back to original geometry`() {
        val driver = FakeSpecDriver(elements = emptyMap())
        val r = Region.bySelector(css = ".missing", fallbackX = 5.0, fallbackY = 6.0, fallbackWidth = 7.0, fallbackHeight = 8.0)
        val resolved = resolveRegion(driver, r)
        assertEquals(5.0, resolved.x); assertEquals(6.0, resolved.y); assertEquals(7.0, resolved.width); assertEquals(8.0, resolved.height)
    }

    @Test
    fun `bySelector factory sets selector and zero geometry by default`() {
        val r = Region.bySelector(".thing")
        assertEquals(".thing", r.selector); assertEquals(0.0, r.x); assertEquals(0.0, r.y)
    }

    @Test
    fun `captureElementScreenshot returns the element bytes`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        val driver = FakeSpecDriver(elements = mapOf(".pic" to FakeSpecElement(Rect(0, 0, 10, 10), png)))
        assertEquals(png.size, captureElementScreenshot(driver, ".pic").size)
    }

    @Test
    fun `captureElementScreenshot throws on a miss`() {
        val driver = FakeSpecDriver(elements = emptyMap())
        assertThrows(IllegalStateException::class.java) { captureElementScreenshot(driver, ".gone") }
    }

    @Test
    fun `findElement throwing falls back to declared geometry`() {
        val driver = FakeSpecDriver(onFindElement = { throw IllegalArgumentException("invalid selector") })
        val r = Region.bySelector(css = ".bad[", fallbackX = 1.0, fallbackY = 2.0, fallbackWidth = 3.0, fallbackHeight = 4.0)
        val resolved = resolveRegion(driver, r)
        assertEquals(1.0, resolved.x)
        assertEquals(2.0, resolved.y)
        assertEquals(3.0, resolved.width)
        assertEquals(4.0, resolved.height)
    }
}
