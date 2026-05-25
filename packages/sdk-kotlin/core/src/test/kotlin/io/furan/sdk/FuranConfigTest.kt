package io.furan.sdk

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class FuranConfigTest {
    @Test
    fun `fromEnv builds with required vars`() {
        val env = mapOf(
            "FURAN_API_URL" to "https://furan.example.com",
            "FURAN_API_TOKEN" to "furan_pat_test_abcdefghijklmnop",
            "FURAN_PROJECT_ID" to "00000000-0000-0000-0000-000000000000",
        )
        val config = FuranConfig.fromEnv(env)
        assertEquals("https://furan.example.com", config.apiUrl)
        assertEquals("main", config.branchName)
        assertEquals(listOf(Viewport(1280, 720)), config.viewports)
        assertTrue(config.telemetryEnabled)
        assertEquals(16, config.batchSize)
    }

    @Test
    fun `fromEnv FURAN_TELEMETRY=0 disables telemetry`() {
        val env = mapOf(
            "FURAN_API_URL" to "https://furan.example.com",
            "FURAN_API_TOKEN" to "tok",
            "FURAN_PROJECT_ID" to "pid",
            "FURAN_TELEMETRY" to "0",
        )
        assertEquals(false, FuranConfig.fromEnv(env).telemetryEnabled)
    }

    @Test
    fun `fromEnv missing required throws`() {
        assertThrows<IllegalStateException> {
            FuranConfig.fromEnv(emptyMap())
        }
    }

    @Test
    fun `fromEnv parses snapshotAndAwait config fields`() {
        val env = mapOf(
            "FURAN_API_URL" to "https://furan.example.com",
            "FURAN_API_TOKEN" to "tok",
            "FURAN_PROJECT_ID" to "pid",
            "FURAN_SOFT_ASSERT" to "true",
            "FURAN_POLL_TIMEOUT_SECONDS" to "120",
            "FURAN_POLL_INTERVAL_SECONDS" to "5",
            "FURAN_DASHBOARD_URL" to "http://localhost:3001/",
        )
        val cfg = FuranConfig.fromEnv(env)
        assertEquals(true, cfg.softAssert)
        assertEquals(120L, cfg.pollTimeoutSeconds)
        assertEquals(5L, cfg.pollIntervalSeconds)
        // Trailing slash trimmed so result composition produces clean URLs.
        assertEquals("http://localhost:3001", cfg.dashboardUrl)
    }

    @Test
    fun `fromEnv softAssert defaults to false when unset or truthy-string mismatched`() {
        val base = mapOf(
            "FURAN_API_URL" to "https://furan.example.com",
            "FURAN_API_TOKEN" to "tok",
            "FURAN_PROJECT_ID" to "pid",
        )
        // Unset: default false.
        assertEquals(false, FuranConfig.fromEnv(base).softAssert)
        // "yes" / "on" are not recognized (we only accept 1 / true).
        assertEquals(false, FuranConfig.fromEnv(base + ("FURAN_SOFT_ASSERT" to "yes")).softAssert)
        assertEquals(true, FuranConfig.fromEnv(base + ("FURAN_SOFT_ASSERT" to "1")).softAssert)
        assertEquals(true, FuranConfig.fromEnv(base + ("FURAN_SOFT_ASSERT" to "TRUE")).softAssert)
    }

    @Test
    fun `init rejects pollIntervalSeconds greater than pollTimeoutSeconds`() {
        assertThrows<IllegalArgumentException> {
            FuranConfig(
                apiUrl = "https://x",
                apiToken = "t",
                projectId = "p",
                pollTimeoutSeconds = 10,
                pollIntervalSeconds = 30,
            )
        }
    }

    @Test
    fun `fromEnv dashboardUrl null when env var unset`() {
        val cfg = FuranConfig.fromEnv(
            mapOf(
                "FURAN_API_URL" to "https://furan.example.com",
                "FURAN_API_TOKEN" to "tok",
                "FURAN_PROJECT_ID" to "pid",
            ),
        )
        assertEquals(null, cfg.dashboardUrl)
    }

    @Test
    fun `require blank apiUrl rejected`() {
        assertThrows<IllegalArgumentException> {
            FuranConfig(apiUrl = "  ", apiToken = "tok", projectId = "pid")
        }
    }

    @Test
    fun `fromEnv parses comma-separated viewports`() {
        val env = mapOf(
            "FURAN_API_URL" to "https://furan.example.com",
            "FURAN_API_TOKEN" to "tok",
            "FURAN_PROJECT_ID" to "pid",
            "FURAN_VIEWPORTS" to "1280x720, 375x812 ,1920x1080",
        )
        val config = FuranConfig.fromEnv(env)
        assertEquals(
            listOf(Viewport(1280, 720), Viewport(375, 812), Viewport(1920, 1080)),
            config.viewports,
        )
    }

    @Test
    fun `fromEnv parses FURAN_BUILD_NAME`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
            "FURAN_BUILD_NAME" to "nightly main",
        )
        assertEquals("nightly main", FuranConfig.fromEnv(env).name)
    }

    @Test
    fun `fromEnv empty FURAN_BUILD_NAME is treated as null`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
            "FURAN_BUILD_NAME" to "   ",
        )
        assertEquals(null, FuranConfig.fromEnv(env).name)
    }

    @Test
    fun `fromEnv parses FURAN_BUILD_PROPERTIES comma-separated`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
            "FURAN_BUILD_PROPERTIES" to "region=us-east-1,shard=2,feature=new-cart",
        )
        assertEquals(
            mapOf("region" to "us-east-1", "shard" to "2", "feature" to "new-cart"),
            FuranConfig.fromEnv(env).properties,
        )
    }

    @Test
    fun `fromEnv parses FURAN_BUILD_PROPERTIES semicolon-separated`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
            "FURAN_BUILD_PROPERTIES" to "region=us-east-1;shard=2",
        )
        assertEquals(
            mapOf("region" to "us-east-1", "shard" to "2"),
            FuranConfig.fromEnv(env).properties,
        )
    }

    @Test
    fun `fromEnv drops malformed FURAN_BUILD_PROPERTIES entries`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
            "FURAN_BUILD_PROPERTIES" to "region=us-east-1,no-eq-here,=empty-key,shard=2",
        )
        assertEquals(
            mapOf("region" to "us-east-1", "shard" to "2"),
            FuranConfig.fromEnv(env).properties,
        )
    }

    @Test
    fun `fromEnv empty FURAN_BUILD_PROPERTIES is empty map`() {
        val env = mapOf(
            "FURAN_API_URL" to "u",
            "FURAN_API_TOKEN" to "t",
            "FURAN_PROJECT_ID" to "p",
        )
        assertEquals(emptyMap<String, String>(), FuranConfig.fromEnv(env).properties)
    }
}
