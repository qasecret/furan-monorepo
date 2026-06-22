package io.furan.sdk.images

import io.furan.sdk.FuranConfig
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class FuranImagesTest {

    private fun config() = FuranConfig(
        apiUrl = "http://127.0.0.1:1", // never dialed by these tests
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false, // so closeClient() does not POST
    )

    @Test
    fun `checkImage before open throws IllegalStateException`() {
        val furan = FuranImages(config())
        try {
            assertThrows(IllegalStateException::class.java) {
                furan.checkImage("home", byteArrayOf(1, 2, 3))
            }
        } finally {
            furan.closeClient()
        }
    }

    @Test
    fun `checkImageAndAwait before open throws IllegalStateException`() {
        val furan = FuranImages(config())
        try {
            assertThrows(IllegalStateException::class.java) {
                furan.checkImageAndAwait("home", byteArrayOf(1, 2, 3))
            }
        } finally {
            furan.closeClient()
        }
    }

    @Test
    fun `close with no open run returns null`() {
        val furan = FuranImages(config())
        try {
            assertNull(furan.close())
        } finally {
            furan.closeClient()
        }
    }

    @Test
    fun `abort with no open run does not throw`() {
        val furan = FuranImages(config())
        try {
            furan.abort()
        } finally {
            furan.closeClient()
        }
    }
}
