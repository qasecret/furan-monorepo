package io.furan.sdk.http

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HttpBodyTest {

    @Test
    fun `Empty is a singleton object`() {
        val a: HttpBody = HttpBody.Empty
        val b: HttpBody = HttpBody.Empty
        assertEquals(a, b)
        assertTrue(a === b)
    }

    @Test
    fun `Bytes carries content type and equals by content`() {
        val a = HttpBody.Bytes(bytes = byteArrayOf(1, 2, 3), contentType = "image/png")
        val b = HttpBody.Bytes(bytes = byteArrayOf(1, 2, 3), contentType = "image/png")
        assertEquals(a.bytes.size, b.bytes.size)
        assertEquals(a.contentType, b.contentType)
    }

    @Test
    fun `JsonString carries the serialized payload`() {
        val a = HttpBody.JsonString(json = """{"key":"value"}""")
        val b = HttpBody.JsonString(json = """{"key":"value"}""")
        val c = HttpBody.JsonString(json = """{"other":1}""")
        assertEquals(a, b)
        assertNotEquals(a, c)
        assertEquals("""{"key":"value"}""", a.json)
    }

    @Test
    fun `Bytes rejects blank content type`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException::class.java) {
            HttpBody.Bytes(bytes = byteArrayOf(), contentType = "")
        }
        assertTrue(ex.message!!.contains("contentType"))
    }
}
