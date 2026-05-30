package io.furan.sdk.selenium

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class FullyStitchTest {

    // --- tileYs (Task 3) -------------------------------------------------

    @Test
    fun `tileYs exact multiple — three tiles of 1000px in 3000px page`() {
        assertEquals(listOf(0, 1000, 2000), tileYs(docHeight = 3000, viewportHeight = 1000))
    }

    @Test
    fun `tileYs partial last tile — last tile clamps to docHeight - viewportHeight`() {
        // docHeight 2500, viewportH 1000:
        //   y=0    → tile 0..1000
        //   y=1000 → tile 1000..2000
        //   y=1500 → tile 1500..2500 (clamped; would overlap previous by 500)
        assertEquals(listOf(0, 1000, 1500), tileYs(docHeight = 2500, viewportHeight = 1000))
    }

    @Test
    fun `tileYs page shorter than viewport — single tile at zero`() {
        assertEquals(listOf(0), tileYs(docHeight = 600, viewportHeight = 1000))
    }

    @Test
    fun `tileYs page equal to viewport — single tile at zero`() {
        assertEquals(listOf(0), tileYs(docHeight = 1000, viewportHeight = 1000))
    }

    @Test
    fun `tileYs document height of zero returns empty list`() {
        // Defensive — should not happen in practice (a rendered page
        // always has positive height) but the math should not crash.
        assertEquals(emptyList<Int>(), tileYs(docHeight = 0, viewportHeight = 1000))
    }
}
