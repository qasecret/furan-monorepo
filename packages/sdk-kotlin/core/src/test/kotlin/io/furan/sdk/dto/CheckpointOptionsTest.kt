package io.furan.sdk.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CheckpointOptionsTest {

    @Test
    fun `fully defaults to false`() {
        assertFalse(CheckpointOptions().fully)
    }

    @Test
    fun `hideFixedElements defaults to empty list`() {
        assertTrue(CheckpointOptions().hideFixedElements.isEmpty())
    }

    @Test
    fun `fully and hideFixedElements can be set together`() {
        val o = CheckpointOptions(
            fully = true,
            hideFixedElements = listOf("header", "footer"),
        )
        assertTrue(o.fully)
        assertEquals(listOf("header", "footer"), o.hideFixedElements)
    }
}
