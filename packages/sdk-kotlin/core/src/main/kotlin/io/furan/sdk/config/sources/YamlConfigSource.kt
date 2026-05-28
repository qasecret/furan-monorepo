package io.furan.sdk.config.sources

import io.furan.sdk.config.ConfigPriority
import io.furan.sdk.config.ConfigSource
import org.yaml.snakeyaml.Yaml
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path

/**
 * Reads a YAML config file and flattens nested maps to dotted keys
 * rooted at `furan.` (Spring-style relaxed binding).
 *
 * Example `application.yml`:
 *
 * ```yaml
 * furan:
 *   apiUrl: http://localhost:3000
 *   apiToken: furan_pat_...
 *   projectId: dd590cdc-48b0-44e8-918c-f10f9ca7f5e7
 *   branchName: main
 *   buildId: null         # explicit null clears any inherited value
 *   viewports:
 *     - { width: 1280, height: 720 }
 *     - { width: 375, height: 812 }
 *   pollTimeoutSeconds: 60
 * ```
 *
 * Flattens to:
 * ```
 * furan.apiUrl = "http://localhost:3000"
 * furan.apiToken = "furan_pat_..."
 * furan.projectId = "dd590cdc-..."
 * furan.branchName = "main"
 * furan.buildId = null
 * furan.viewports = [Map<width,height>, Map<width,height>]
 * furan.pollTimeoutSeconds = 60
 * ```
 *
 * Lists are kept as-is (not flattened) so downstream consumers can
 * receive structured values where they want them. Scalar nulls
 * (literal YAML `null` or the string `"null"`) are normalised to
 * actual `null` per the SDK's null-clears merge rule.
 *
 * Priority: `ConfigPriority.YAML` (50) — sits between SYSPROP and
 * DEFAULTS. Env vars and JVM sysprops override YAML; YAML overrides
 * the built-in defaults.
 *
 * The source streams the file lazily through SnakeYAML; the file is
 * re-read on every `load()` so hot-reload via a `ConfigurationResolver`
 * sweep picks up edits. If the file is absent, `load()` returns an
 * empty map — the source is non-fatal.
 *
 * ## Construction
 *
 * Production code uses one of the factories:
 * - [forFile] — explicit path, fails fast at config-time if path is
 *   invalid (but tolerates a missing file at load time).
 * - [forClasspath] — looks up `application.yml` (or the operator-chosen
 *   resource name) on the JVM classpath via the bootstrap class loader.
 *
 * Tests inject `InputStream` providers directly via the primary
 * constructor.
 */
class YamlConfigSource(
    override val name: String,
    private val streamProvider: () -> InputStream?,
) : ConfigSource {

    override val priority: Int = ConfigPriority.YAML

    override fun load(): Map<String, Any?> {
        val stream = streamProvider() ?: return emptyMap()
        return stream.use { s ->
            val raw = Yaml().load<Any?>(s) ?: return@use emptyMap()
            require(raw is Map<*, *>) {
                "YAML root must be a map (got ${raw.javaClass.simpleName})"
            }
            val flat = LinkedHashMap<String, Any?>()
            flatten("", raw, flat)
            flat
        }
    }

    private fun flatten(prefix: String, node: Map<*, *>, out: MutableMap<String, Any?>) {
        for ((key, value) in node) {
            val keyStr = key?.toString() ?: continue
            val fullKey = if (prefix.isEmpty()) keyStr else "$prefix.$keyStr"
            when {
                value is Map<*, *> -> flatten(fullKey, value, out)
                value == null || value == "null" -> out[fullKey] = null
                else -> out[fullKey] = value
            }
        }
    }

    companion object {
        /** Reads `path` if it exists; returns empty map otherwise. */
        fun forFile(path: Path, name: String = "yaml:$path"): YamlConfigSource =
            YamlConfigSource(
                name = name,
                streamProvider = { if (Files.exists(path)) Files.newInputStream(path) else null },
            )

        /** Loads a classpath resource (e.g. `application.yml`) via the bootstrap loader. */
        fun forClasspath(resource: String = "application.yml"): YamlConfigSource =
            YamlConfigSource(
                name = "yaml:classpath:$resource",
                streamProvider = {
                    Thread.currentThread().contextClassLoader?.getResourceAsStream(resource)
                        ?: ClassLoader.getSystemResourceAsStream(resource)
                },
            )
    }
}
