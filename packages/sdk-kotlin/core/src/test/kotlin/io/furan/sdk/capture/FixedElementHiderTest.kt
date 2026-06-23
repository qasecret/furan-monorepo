package io.furan.sdk.capture

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FixedElementHiderTest {

    @Test
    fun `inject passes joined CSS rule as a single argument`() {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args -> calls.add(script to args.toList()); null },
        )
        injectFixedElementHider(driver, listOf("header", "footer"))
        // One script call.
        val (script, args) = calls.single()
        // The script SOURCE must reference the style id (for the bookkeeping
        // tag) and must read from arguments[0] — selectors must NOT appear
        // interpolated into the source.
        assertTrue(script.contains("__furan_fixed_hide"), "style id present: $script")
        assertTrue(script.contains("arguments[0]"), "must read CSS from arguments[0]: $script")
        assertEquals(false, script.contains("header"),
            "selectors must not be interpolated into script source: $script")
        // The CSS rule is the single argument.
        assertEquals(1, args.size)
        assertEquals("header,footer{display:none !important}", args[0])
    }

    @Test
    fun `inject is a no-op when selectors list is empty`() {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args -> calls.add(script to args.toList()); null },
        )
        injectFixedElementHider(driver, emptyList())
        assertEquals(0, calls.size)
    }

    @Test
    fun `remove deletes the style element`() {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args -> calls.add(script to args.toList()); null },
        )
        removeFixedElementHider(driver)
        val (script, _) = calls.single()
        assertTrue(script.contains("__furan_fixed_hide"))
        assertTrue(script.contains("remove"), "must call .remove(): $script")
    }

    @Test
    fun `hostile selectors pass through the argument channel, not the script source`() {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        val driver = FakeSpecDriver(
            onExecuteScript = { script, args -> calls.add(script to args.toList()); null },
        )
        // A selector containing a single-quote, brace, and CSS rule-break
        // attempt. With argument-passing, it lands in args[0] unmodified
        // and cannot escape into the script source.
        val hostile = "'); alert('xss'); //"
        injectFixedElementHider(driver, listOf(hostile))
        val (script, args) = calls.single()
        // The hostile substring must NOT appear in the script source.
        assertEquals(false, script.contains("alert"),
            "hostile selector must not leak into script source: $script")
        assertEquals(false, script.contains(hostile),
            "hostile selector must not appear in script source: $script")
        // It IS present in arguments[0] — that's fine because it never
        // gets evaluated as JS, only assigned to textContent.
        assertTrue((args[0] as String).contains(hostile),
            "hostile selector is preserved in arguments[0] (assigned to textContent, never eval'd)")
    }
}
