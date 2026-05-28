package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.ByteArrayInputStream
import java.nio.file.Files

class YamlConfigSourceTest {

    private fun fromYaml(yaml: String): YamlConfigSource =
        YamlConfigSource(
            name = "test-yaml",
            streamProvider = { ByteArrayInputStream(yaml.trimIndent().toByteArray()) },
        )

    @Test
    fun `has correct name and priority`() {
        val src = fromYaml("furan:\n  apiUrl: http://test")
        assertEquals("test-yaml", src.name)
        assertEquals(ConfigPriority.YAML, src.priority)
        assertEquals(50, src.priority)
    }

    @Test
    fun `flat keys load with furan dot prefix preserved`() {
        val src = fromYaml("""
            furan:
              apiUrl: http://localhost:3000
              apiToken: test-token-value
        """)
        val loaded = src.load()
        assertEquals("http://localhost:3000", loaded["furan.apiUrl"])
        assertEquals("test-token-value", loaded["furan.apiToken"])
    }

    @Test
    fun `nested maps flatten to dotted keys`() {
        val src = fromYaml("""
            furan:
              retry:
                maxAttempts: 5
                backoffMs: 100
        """)
        val loaded = src.load()
        assertEquals(5, loaded["furan.retry.maxAttempts"])
        assertEquals(100, loaded["furan.retry.backoffMs"])
    }

    @Test
    fun `literal null value normalised to actual null`() {
        val src = fromYaml("""
            furan:
              buildId: null
        """)
        val loaded = src.load()
        assertTrue(loaded.containsKey("furan.buildId"))
        assertNull(loaded["furan.buildId"])
    }

    @Test
    fun `string null normalised to actual null`() {
        val src = fromYaml("""
            furan:
              buildId: "null"
        """)
        val loaded = src.load()
        assertTrue(loaded.containsKey("furan.buildId"))
        assertNull(loaded["furan.buildId"])
    }

    @Test
    fun `lists of viewport-shaped maps preserved as list`() {
        val src = fromYaml("""
            furan:
              viewports:
                - { width: 1280, height: 720 }
                - { width: 375, height: 812 }
        """)
        val loaded = src.load()
        val viewports = loaded["furan.viewports"]
        assertTrue(viewports is List<*>, "expected List but got ${viewports?.javaClass}")
        @Suppress("UNCHECKED_CAST")
        val list = viewports as List<Map<*, *>>
        assertEquals(2, list.size)
        assertEquals(1280, list[0]["width"])
        assertEquals(720, list[0]["height"])
        assertEquals(375, list[1]["width"])
        assertEquals(812, list[1]["height"])
    }

    @Test
    fun `missing file returns empty map without exception`() {
        val path = Files.createTempDirectory("yaml-test").resolve("nonexistent.yml")
        val src = YamlConfigSource.forFile(path)
        val loaded = src.load()
        assertTrue(loaded.isEmpty())
    }

    @Test
    fun `empty file returns empty map`() {
        val src = YamlConfigSource(name = "empty", streamProvider = { ByteArrayInputStream(ByteArray(0)) })
        val loaded = src.load()
        assertTrue(loaded.isEmpty())
    }

    @Test
    fun `top-level non-map throws IllegalArgumentException`() {
        val src = YamlConfigSource(
            name = "bad",
            streamProvider = { ByteArrayInputStream("- item1\n- item2\n".toByteArray()) },
        )
        assertThrows<IllegalArgumentException> { src.load() }
    }

    @Test
    fun `classpath factory loads test-application yml`() {
        val src = YamlConfigSource.forClasspath("test-application.yml")
        val loaded = src.load()
        assertEquals("http://classpath-test:3000", loaded["furan.apiUrl"])
        assertEquals("test-token-for-classpath-loading", loaded["furan.apiToken"])
        assertEquals("classpath-project-id", loaded["furan.projectId"])
        assertEquals("classpath-branch", loaded["furan.branchName"])
    }

    @Test
    fun `forFile name defaults to yaml colon path`() {
        val path = Files.createTempFile("test", ".yml")
        try {
            path.toFile().writeText("furan:\n  apiUrl: http://x\n")
            val src = YamlConfigSource.forFile(path)
            assertTrue(src.name.startsWith("yaml:"), "expected name to start with 'yaml:' but was '${src.name}'")
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `forFile reads existing file correctly`() {
        val path = Files.createTempFile("yaml-source-test", ".yml")
        try {
            path.toFile().writeText("""
                furan:
                  apiUrl: http://file-test:3000
                  pollTimeoutSeconds: 120
            """.trimIndent())
            val src = YamlConfigSource.forFile(path)
            val loaded = src.load()
            assertEquals("http://file-test:3000", loaded["furan.apiUrl"])
            assertEquals(120, loaded["furan.pollTimeoutSeconds"])
        } finally {
            Files.deleteIfExists(path)
        }
    }
}
