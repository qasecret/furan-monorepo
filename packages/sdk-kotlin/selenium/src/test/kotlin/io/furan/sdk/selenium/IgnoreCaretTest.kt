package io.furan.sdk.selenium

import io.furan.sdk.dto.Region
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class IgnoreCaretTest {

    @Test
    fun `augmentIgnoreRegions with ignoreCaret=false returns the input unchanged`() {
        val input = listOf(
            Region(x = 10.0, y = 20.0, width = 30.0, height = 40.0),
            Region.bySelector(".sidebar"),
        )
        val out = Furan.augmentIgnoreRegions(input, ignoreCaret = false)
        assertSame(input, out, "expected the original list to be returned unchanged")
    }

    @Test
    fun `augmentIgnoreRegions with ignoreCaret=true appends CARET_FOCUS_REGION`() {
        val input = listOf(Region(x = 0.0, y = 0.0, width = 10.0, height = 10.0))
        val out = Furan.augmentIgnoreRegions(input, ignoreCaret = true)
        assertEquals(2, out.size)
        assertEquals(input[0], out[0])
        // The appended entry is the canonical CARET_FOCUS_REGION constant.
        assertSame(Furan.CARET_FOCUS_REGION, out[1])
    }

    @Test
    fun `augmentIgnoreRegions with empty input + ignoreCaret=true returns single caret region`() {
        val out = Furan.augmentIgnoreRegions(emptyList(), ignoreCaret = true)
        assertEquals(1, out.size)
        assertSame(Furan.CARET_FOCUS_REGION, out[0])
    }

    @Test
    fun `CARET_FOCUS_REGION targets the standard focused-text-input selectors`() {
        val r = Furan.CARET_FOCUS_REGION
        assertNotNull(r.selector)
        assertTrue(r.selector!!.contains("input:focus"))
        assertTrue(r.selector!!.contains("textarea:focus"))
        assertTrue(r.selector!!.contains("[contenteditable]:focus"))
    }

    @Test
    fun `CARET_FOCUS_REGION fallback geometry is zero so selector miss is a no-op`() {
        // A selector miss on a region with zero width/height resolves
        // to a zero-area bbox, which the engine treats as a no-op mask.
        // This is the right fallback for the caret case: if there's no
        // focused input, ignoreCaret should mask nothing rather than
        // silently mask some random fallback rectangle.
        val r = Furan.CARET_FOCUS_REGION
        assertEquals(0.0, r.x)
        assertEquals(0.0, r.y)
        assertEquals(0.0, r.width)
        assertEquals(0.0, r.height)
    }
}
