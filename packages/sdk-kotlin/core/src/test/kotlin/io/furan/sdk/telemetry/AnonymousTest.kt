package io.furan.sdk.telemetry

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AnonymousTest {
    @Test
    fun `counts successes and errors independently`() {
        val counter = AnonymousCounter(sdkVersion = "0.5.0", adapter = "selenium")
        repeat(3) { counter.recordSuccess() }
        repeat(2) { counter.recordError() }
        val snap = counter.snapshot()
        assertEquals(3L, snap.success)
        assertEquals(2L, snap.errors)
        assertEquals("kotlin", snap.sdk)
        assertEquals("0.5.0", snap.version)
        assertEquals("selenium", snap.adapter)
        assertTrue(snap.os.isNotBlank())
    }

    @Test
    fun `snapshot does not contain PII fields`() {
        // Defense: serialize and assert the payload only carries the allowed keys.
        val snap = AnonymousCounter("0.5.0", "playwright").snapshot()
        val codec = kotlinx.serialization.json.Json { encodeDefaults = true }
        val json = codec.encodeToString(SdkTelemetryPayload.serializer(), snap)
        // Allowed keys
        listOf("sdk", "version", "adapter", "os", "success", "errors").forEach {
            assertTrue(json.contains("\"$it\""), "expected key '$it' in payload, got: $json")
        }
        // Disallowed leakage patterns (PII / secrets / stack traces)
        listOf("projectId", "runId", "userId", "stack", "trace", "email", "apiToken").forEach {
            assertTrue(
                !json.contains(it, ignoreCase = true),
                "unexpected key '$it' in payload: $json",
            )
        }
    }
}
