package io.furan.sdk.dto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RunStatusTest {
    @Test
    fun `fromWire maps every canonical wire value to its enum`() {
        // Lock down the contract — if the server's run_status enum changes,
        // this test forces an audible failure rather than a silent fallback.
        assertEquals(RunStatus.NEW, RunStatus.fromWire("new"))
        assertEquals(RunStatus.RUNNING, RunStatus.fromWire("running"))
        assertEquals(RunStatus.PASSED, RunStatus.fromWire("passed"))
        assertEquals(RunStatus.UNRESOLVED, RunStatus.fromWire("unresolved"))
        assertEquals(RunStatus.FAILED, RunStatus.fromWire("failed"))
        assertEquals(RunStatus.ABORTED, RunStatus.fromWire("aborted"))
        assertEquals(RunStatus.EMPTY, RunStatus.fromWire("empty"))
    }

    @Test
    fun `fromWire is case-sensitive and falls back to UNRESOLVED on unknown values`() {
        // Forward compat: a server that adds a new status string keeps old
        // SDK clients working — they bucket the unknown as UNRESOLVED so
        // assertions still fire.
        assertEquals(RunStatus.UNRESOLVED, RunStatus.fromWire("PASSED"))
        assertEquals(RunStatus.UNRESOLVED, RunStatus.fromWire("brand_new_status"))
        assertEquals(RunStatus.UNRESOLVED, RunStatus.fromWire(""))
    }

    @Test
    fun `isTerminal returns true for terminal statuses and false for in-flight`() {
        assertFalse(RunStatus.NEW.isTerminal())
        assertFalse(RunStatus.RUNNING.isTerminal())
        assertTrue(RunStatus.PASSED.isTerminal())
        assertTrue(RunStatus.UNRESOLVED.isTerminal())
        assertTrue(RunStatus.FAILED.isTerminal())
        assertTrue(RunStatus.ABORTED.isTerminal())
        assertTrue(RunStatus.EMPTY.isTerminal())
    }

    @Test
    fun `isFailure returns true only for reviewer-actionable failure terminals`() {
        // PASSED + EMPTY are terminal but NOT a failure: PASSED is the
        // happy path; EMPTY means no screenshots were captured for this
        // run (legitimate empty test, e.g. a hooks failure handled
        // upstream) — the SDK should not throw on EMPTY.
        assertFalse(RunStatus.NEW.isFailure())
        assertFalse(RunStatus.RUNNING.isFailure())
        assertFalse(RunStatus.PASSED.isFailure())
        assertFalse(RunStatus.EMPTY.isFailure())
        assertTrue(RunStatus.UNRESOLVED.isFailure())
        assertTrue(RunStatus.FAILED.isFailure())
        assertTrue(RunStatus.ABORTED.isFailure())
    }

    @Test
    fun `serializer encodes to the wire string`() {
        val json = Json.encodeToString(RunStatus.serializer(), RunStatus.PASSED)
        assertEquals("\"passed\"", json)
    }

    @Test
    fun `serializer decodes the wire string`() {
        val decoded = Json.decodeFromString(RunStatus.serializer(), "\"unresolved\"")
        assertEquals(RunStatus.UNRESOLVED, decoded)
    }

    @Test
    fun `serializer falls back to UNRESOLVED on unknown wire string (no throw)`() {
        val decoded = Json.decodeFromString(RunStatus.serializer(), "\"future_status\"")
        assertEquals(RunStatus.UNRESOLVED, decoded)
    }

    @Test
    fun `decoded RunResponse uses typed RunStatus`() {
        // End-to-end: confirm the RunResponse deserializer applies the
        // tolerant serializer when status is present. Locks in the
        // wire-shape contract a polling client depends on.
        val payload = JsonObject(
            mapOf(
                "id" to JsonPrimitive("r1"),
                "projectId" to JsonPrimitive("p1"),
                "buildId" to JsonPrimitive("b1"),
                "status" to JsonPrimitive("passed"),
            ),
        )
        val res = Json.decodeFromJsonElement(RunResponse.serializer(), payload)
        assertEquals(RunStatus.PASSED, res.status)
    }
}
