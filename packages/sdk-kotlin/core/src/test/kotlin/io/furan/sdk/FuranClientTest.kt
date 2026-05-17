package io.furan.sdk

import org.junit.jupiter.api.Test

class FuranClientTest {
    private fun testConfig() = FuranConfig(
        apiUrl = "http://127.0.0.1:1", // won't be hit in Task 2 (no actual post)
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false, // disable so close() doesn't try to POST
    )

    @Test
    fun `constructs without error`() {
        val client = FuranClient(testConfig(), adapter = "test")
        client.close()
    }
}
