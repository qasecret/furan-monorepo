package io.furan.sdk

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ElementBboxScriptTest {
    @Test
    fun `script returns its value so it survives a function-wrapping evaluate`() {
        assertTrue(
            ELEMENT_BBOX_SCRIPT.trimStart().startsWith("return "),
            "ELEMENT_BBOX_SCRIPT must start with `return` to survive function-wrapping",
        )
    }
}
