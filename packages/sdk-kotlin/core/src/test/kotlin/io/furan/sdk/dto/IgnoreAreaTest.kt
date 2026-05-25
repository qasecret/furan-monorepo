package io.furan.sdk.dto

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class IgnoreAreaTest {
    @Test
    fun `serializes to the wire shape the server expects`() {
        val area = IgnoreArea(x = 10, y = 20, width = 30, height = 40, viewport = "1280x720")
        val json = Json.encodeToString(IgnoreArea.serializer(), area)
        // Server-side schema (apps/api/src/routes/sdk-runs.ts:ignoreAreaSchema)
        // expects exactly these field names; field order matters for
        // human readability of the test, not for the wire.
        val parsed = Json.parseToJsonElement(json).toString()
        assertEquals(true, parsed.contains("\"x\":10"))
        assertEquals(true, parsed.contains("\"y\":20"))
        assertEquals(true, parsed.contains("\"width\":30"))
        assertEquals(true, parsed.contains("\"height\":40"))
        assertEquals(true, parsed.contains("\"viewport\":\"1280x720\""))
    }

    @Test
    fun `omits viewport when null (clean wire payload)`() {
        val area = IgnoreArea(x = 0, y = 0, width = 10, height = 10)
        val json = Json.encodeToString(IgnoreArea.serializer(), area)
        // null viewport must not appear on the wire — keeps the server
        // schema's optional field validator happy + matches the
        // Java SDK's behavior.
        assertEquals(false, json.contains("viewport"))
    }

    @Test
    fun `rejects negative coordinates`() {
        // The dashboard's ignoreRegionElementSchema (apps/api/src/trpc/v1/runs.ts)
        // also rejects negatives. Catching client-side gives users a
        // clearer stack than waiting for the 400.
        assertThrows<IllegalArgumentException> {
            IgnoreArea(x = -1, y = 0, width = 10, height = 10)
        }
        assertThrows<IllegalArgumentException> {
            IgnoreArea(x = 0, y = -1, width = 10, height = 10)
        }
    }

    @Test
    fun `rejects zero or negative dimensions`() {
        // An IgnoreArea with width=0 or height=0 covers no pixels; the
        // server already 400s. Fail fast on the client side too.
        assertThrows<IllegalArgumentException> {
            IgnoreArea(x = 0, y = 0, width = 0, height = 10)
        }
        assertThrows<IllegalArgumentException> {
            IgnoreArea(x = 0, y = 0, width = 10, height = 0)
        }
        assertThrows<IllegalArgumentException> {
            IgnoreArea(x = 0, y = 0, width = -5, height = 10)
        }
    }
}
