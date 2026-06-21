package io.furan.sdk

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.nio.file.Files

class FuranConfigYamlTest {

    private fun yamlFile(content: String): java.nio.file.Path {
        val path = Files.createTempFile("furan-config-test", ".yml")
        path.toFile().writeText(content.trimIndent())
        return path
    }

    @Test
    fun `YAML provides required fields and config is built`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals("http://yaml-test:3000", config.apiUrl)
            assertEquals("test-token-value", config.apiToken)
            assertEquals("yaml-project-id", config.projectId)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `env overrides YAML for apiUrl`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-host:3000
              apiToken: test-token-value
              projectId: yaml-project-id
        """)
        try {
            val config = FuranConfig.fromYaml(
                path,
                mapOf("FURAN_API_URL" to "http://env-override:9000"),
            )
            assertEquals("http://env-override:9000", config.apiUrl)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML viewports list parsed correctly`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              viewports:
                - { width: 1280, height: 720 }
                - { width: 375, height: 812 }
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals(2, config.viewports.size)
            assertEquals(Viewport(1280, 720), config.viewports[0])
            assertEquals(Viewport(375, 812), config.viewports[1])
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `missing required field in both YAML and env throws FuranConfigException with helpful message`() {
        val path = yamlFile("""
            furan:
              apiToken: test-token-value
              projectId: yaml-project-id
        """)
        try {
            val ex = assertThrows<FuranConfigException> {
                FuranConfig.fromYaml(path, emptyMap())
            }
            assertTrue(
                ex.message?.contains("FURAN_API_URL") == true || ex.message?.contains("furan.apiUrl") == true,
                "Expected message to mention FURAN_API_URL or furan.apiUrl, got: ${ex.message}",
            )
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML provides pollTimeoutSeconds as int and it is applied`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              pollTimeoutSeconds: 120
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals(120L, config.pollTimeoutSeconds)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML softAssert true boolean is applied`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              softAssert: true
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertTrue(config.softAssert)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML branchName defaults to main when absent`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals("main", config.branchName)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `parentBranchName from YAML, overridden by env FURAN_PARENT_BRANCH (ADR-055)`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              parentBranchName: yaml-parent
        """)
        try {
            assertEquals(
                "yaml-parent",
                FuranConfig.fromYaml(path, emptyMap()).parentBranchName,
            )
            assertEquals(
                "env-parent",
                FuranConfig.fromYaml(
                    path,
                    mapOf("FURAN_PARENT_BRANCH" to "env-parent"),
                ).parentBranchName,
            )
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `parentBranchName absent in both YAML and env stays null`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
        """)
        try {
            assertNull(FuranConfig.fromYaml(path, emptyMap()).parentBranchName)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `env FURAN_BRANCH overrides YAML branchName`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              branchName: yaml-branch
        """)
        try {
            val config = FuranConfig.fromYaml(
                path,
                mapOf("FURAN_BRANCH" to "env-branch"),
            )
            assertEquals("env-branch", config.branchName)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `missing required apiToken in both YAML and env throws FuranConfigException`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              projectId: yaml-project-id
        """)
        try {
            val ex = assertThrows<FuranConfigException> {
                FuranConfig.fromYaml(path, emptyMap())
            }
            assertTrue(
                ex.message?.contains("FURAN_API_TOKEN") == true || ex.message?.contains("furan.apiToken") == true,
                "Expected message to mention token, got: ${ex.message}",
            )
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML dashboardUrl trailing slash stripped`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              dashboardUrl: http://dashboard:3001/
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals("http://dashboard:3001", config.dashboardUrl)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `empty viewports list in YAML falls back to default viewport`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              viewports: []
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertEquals(listOf(Viewport(1280, 720)), config.viewports)
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `YAML buildId null keeps field as null`() {
        val path = yamlFile("""
            furan:
              apiUrl: http://yaml-test:3000
              apiToken: test-token-value
              projectId: yaml-project-id
              buildId: null
        """)
        try {
            val config = FuranConfig.fromYaml(path, emptyMap())
            assertNull(config.buildId)
        } finally {
            Files.deleteIfExists(path)
        }
    }
}
