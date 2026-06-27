package io.furan.sdk

data class Viewport(val width: Int, val height: Int, val deviceScaleFactor: Double? = null)

data class FuranConfig(
    val apiUrl: String,
    val apiToken: String,
    val projectId: String,
    val buildId: String? = null,
    val branchName: String = "main",
    /**
     * Parent branch in the branch hierarchy (Applitools `setParentBranchName`
     * analog). Sent on `POST /runs` so the server's baseline resolution can
     * fall back to the parent branch's baseline when this branch has none.
     * From `FURAN_PARENT_BRANCH`. Null = no parent (the parent_pr fallback
     * tier is skipped).
     */
    val parentBranchName: String? = null,
    /** Applitools BATCH_NAME parallel. Populated from FURAN_BUILD_NAME. */
    val name: String? = null,
    /** Applitools `addProperty` parallel. Populated from FURAN_BUILD_PROPERTIES. */
    val properties: Map<String, String> = emptyMap(),
    val viewports: List<Viewport> = listOf(Viewport(1280, 720)),
    val batchSize: Int = 16,
    val logLevel: String = "info",
    val telemetryEnabled: Boolean = true,
    val caCertPath: String? = null,
    /**
     * Controls `FuranClient.snapshotAndAwait()` behavior on failure
     * terminals. When `false` (default — matches the Java SDK), the
     * client throws [io.furan.sdk.FuranAssertionException] on
     * `UNRESOLVED`/`FAILED`/`ABORTED`. When `true`, the client returns
     * the [io.furan.sdk.dto.SnapshotResult] and the caller asserts
     * explicitly. From `FURAN_SOFT_ASSERT` (truthy = true).
     */
    val softAssert: Boolean = false,
    /**
     * Max time `snapshotAndAwait()` waits for the diff worker to
     * produce a terminal status before throwing
     * [io.furan.sdk.FuranTimeoutException]. From `FURAN_POLL_TIMEOUT_SECONDS`.
     * 60 s covers cold-start diff queues; bump to 300+ for slow CI.
     */
    val pollTimeoutSeconds: Long = 60,
    /**
     * Polling cadence within the timeout window. From
     * `FURAN_POLL_INTERVAL_SECONDS`. Smaller values shorten happy-path
     * latency but hammer the api; 2 s is the same default the dashboard
     * uses for analogous polling.
     */
    val pollIntervalSeconds: Long = 2,
    /**
     * Dashboard origin (no trailing slash). When set, `SnapshotResult`s
     * carry a `diffViewerUrl` deep link for CI logs. From
     * `FURAN_DASHBOARD_URL`. Null = no link composition (matches v1.0
     * behavior).
     */
    val dashboardUrl: String? = null,
    /**
     * Controls whether [io.furan.sdk.selenium.Furan.close] throws
     * [FuranDiffException] when the run ends with unresolved/failed
     * checkpoints. From `FURAN_FAIL_ON_DIFF` (None/AfterEach/AfterAll).
     * Default: [FailOnDiff.None].
     */
    val failOnDiff: FailOnDiff = FailOnDiff.None,
    /**
     * Applitools `saveNewTests` analog. When true, a first-run/no-baseline
     * `new` checkpoint is auto-approved client-side (seeds the baseline) and
     * reported PASSED. Default false (native Furan = manual baseline). The
     * Loupe facade defaults this true. From FURAN_SAVE_NEW_TESTS.
     */
    val saveNewTests: Boolean = false,
    /**
     * RESERVED — currently unread; no behavior depends on this field yet.
     * Reserved for future Loupe-vs-native divergence gating (e.g. controlling
     * which close/approve semantics are applied). Do not branch on this value
     * until a superseding ADR activates it.
     */
    val compatibility: CompatibilityMode = CompatibilityMode.APPLITOOLS,
    /**
     * Operating-system label for the captured environment (Applitools host-OS
     * analog), e.g. "Windows", "macOS", "Linux". Part of the baseline identity
     * (the `test_variations` environment tuple), so distinct OS values keep
     * distinct baselines. From `FURAN_OS`. Null (default) leaves it to the
     * adapter's captured OS, if any — preserving prior behavior when unset.
     */
    val os: String? = null,
    /**
     * Device label for the captured environment (Applitools device analog),
     * e.g. "iPhone 15", "Pixel 8". Part of the baseline identity; mainly for
     * Appium/mobile. From `FURAN_DEVICE`. Null (default) = unset.
     */
    val device: String? = null,
    /**
     * Browser label for the captured environment, e.g. "chrome", "firefox".
     * Overrides the adapter's auto-detected browser (useful for remote grids
     * where detection is unreliable). Part of the baseline identity. From
     * `FURAN_BROWSER`. Null (default) = use the adapter's detected browser.
     */
    val browser: String? = null,
) {
    init {
        require(apiUrl.isNotBlank()) { "apiUrl must be non-blank" }
        require(apiToken.isNotBlank()) { "apiToken must be non-blank" }
        require(projectId.isNotBlank()) { "projectId must be non-blank" }
        require(batchSize >= 1) { "batchSize must be >= 1" }
        require(pollTimeoutSeconds >= 1) { "pollTimeoutSeconds must be >= 1" }
        require(pollIntervalSeconds >= 1) { "pollIntervalSeconds must be >= 1" }
        require(pollIntervalSeconds <= pollTimeoutSeconds) {
            "pollIntervalSeconds ($pollIntervalSeconds) must be <= pollTimeoutSeconds ($pollTimeoutSeconds)"
        }
    }

    companion object {
        /**
         * Build a config from FURAN_* env vars. Throws
         * [FuranConfigException] on missing/invalid env (wraps any
         * underlying [IllegalArgumentException] / [IllegalStateException]
         * from the [FuranConfig] init block so user code only needs to
         * catch one exception type).
         *
         * FURAN_VIEWPORTS uses a compact comma-separated `WIDTHxHEIGHT`
         * format, e.g. `1280x720,375x812`. (Defensible deviation from the
         * spec's JSON-array sketch: the spec note explicitly authorizes
         * this simpler format. Avoids pulling kotlinx-serialization into
         * config bootstrap.)
         */
        fun fromEnv(env: Map<String, String> = System.getenv()): FuranConfig = try {
            buildFromEnv(env)
        } catch (e: FuranConfigException) {
            throw e
        } catch (e: IllegalArgumentException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        } catch (e: IllegalStateException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        }

        private fun buildFromEnv(env: Map<String, String>): FuranConfig {
            val apiUrl = env["FURAN_API_URL"]
                ?: throw FuranConfigException("FURAN_API_URL is required")
            val apiToken = env["FURAN_API_TOKEN"]
                ?: throw FuranConfigException("FURAN_API_TOKEN is required")
            val projectId = env["FURAN_PROJECT_ID"]
                ?: throw FuranConfigException("FURAN_PROJECT_ID is required")
            return FuranConfig(
                apiUrl = apiUrl,
                apiToken = apiToken,
                projectId = projectId,
                buildId = env["FURAN_BUILD_ID"],
                branchName = env["FURAN_BRANCH"] ?: "main",
                parentBranchName = env["FURAN_PARENT_BRANCH"]?.trim()?.takeIf { it.isNotEmpty() },
                name = env["FURAN_BUILD_NAME"]?.trim()?.takeIf { it.isNotEmpty() },
                properties = parseProperties(env["FURAN_BUILD_PROPERTIES"]),
                viewports = env["FURAN_VIEWPORTS"]?.let(::parseViewports) ?: listOf(Viewport(1280, 720)),
                batchSize = env["FURAN_BATCH_SIZE"]?.toIntOrNull() ?: 16,
                logLevel = env["FURAN_LOG_LEVEL"] ?: "info",
                telemetryEnabled = env["FURAN_TELEMETRY"]?.let { it != "0" && it.lowercase() != "false" } ?: true,
                caCertPath = env["FURAN_CA_CERT_PATH"],
                softAssert = env["FURAN_SOFT_ASSERT"]?.let { it == "1" || it.lowercase() == "true" } ?: false,
                pollTimeoutSeconds = env["FURAN_POLL_TIMEOUT_SECONDS"]?.toLongOrNull() ?: 60,
                pollIntervalSeconds = env["FURAN_POLL_INTERVAL_SECONDS"]?.toLongOrNull() ?: 2,
                dashboardUrl = env["FURAN_DASHBOARD_URL"]?.trimEnd('/')?.takeIf { it.isNotEmpty() },
                failOnDiff = env["FURAN_FAIL_ON_DIFF"]?.let { v ->
                    FailOnDiff.entries.firstOrNull { it.name.equals(v, ignoreCase = true) }
                        ?: throw FuranConfigException("invalid FURAN_FAIL_ON_DIFF: $v")
                } ?: FailOnDiff.None,
                saveNewTests = env["FURAN_SAVE_NEW_TESTS"]?.let { it == "1" || it.lowercase() == "true" } ?: false,
                os = env["FURAN_OS"]?.trim()?.takeIf { it.isNotEmpty() },
                device = env["FURAN_DEVICE"]?.trim()?.takeIf { it.isNotEmpty() },
                browser = env["FURAN_BROWSER"]?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

        /**
         * Parses `key1=value1,key2=value2` (or `;`-separated) into a Map.
         * Malformed pairs (no `=`, empty key) are dropped from the result and
         * a warning is emitted on stdout via the same `[furan-sdk]` prefix used
         * elsewhere — never fail a test run because of a misformatted CI env var.
         */
        internal fun parseProperties(raw: String?): Map<String, String> {
            if (raw.isNullOrBlank()) return emptyMap()
            val out = mutableMapOf<String, String>()
            for (token in raw.split(',', ';')) {
                val pair = token.trim()
                if (pair.isEmpty()) continue
                val eq = pair.indexOf('=')
                if (eq <= 0) {
                    println("[furan-sdk] Skipping malformed FURAN_BUILD_PROPERTIES entry: '$pair'")
                    continue
                }
                val key = pair.substring(0, eq).trim()
                val value = pair.substring(eq + 1).trim()
                if (key.isEmpty()) {
                    println("[furan-sdk] Skipping malformed FURAN_BUILD_PROPERTIES entry: '$pair'")
                    continue
                }
                out[key] = value
            }
            return out.toMap()
        }

        /**
         * Build a config from a YAML file at [path], falling back to [env]
         * for any field not present in the YAML. Env wins per the SDK's
         * Spring-style precedence (env > yaml).
         *
         * Useful for callers who want declarative file-based config
         * alongside the usual `FuranConfig.fromEnv()`.
         *
         * Throws [FuranConfigException] if the resulting config is invalid
         * (missing required fields, malformed values).
         *
         * Expected YAML shape (all under `furan.`):
         * ```yaml
         * furan:
         *   apiUrl: ...        # required
         *   apiToken: ...      # required
         *   projectId: ...     # required
         *   branchName: main
         *   buildId: null
         *   viewports:
         *     - { width: 1280, height: 720 }
         *   pollTimeoutSeconds: 60
         *   ...                # all other FuranConfig fields supported
         * ```
         */
        fun fromYaml(
            path: java.nio.file.Path,
            env: Map<String, String> = System.getenv(),
        ): FuranConfig = try {
            val yamlSource = io.furan.sdk.config.sources.YamlConfigSource.forFile(path)
            val yaml = yamlSource.load()
            buildMerged(yaml, env)
        } catch (e: FuranConfigException) {
            throw e
        } catch (e: IllegalArgumentException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        } catch (e: IllegalStateException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        }

        /**
         * Auto-discovery factory: looks up [resource] (default
         * `application.yml`) on the JVM classpath via the context class
         * loader. Mirrors `YamlConfigSource.forClasspath()` and matches
         * the ReportPortal `reportportal.properties` pattern — drop the
         * file under `src/test/resources/` (or any classpath root) and
         * the SDK picks it up without an explicit path.
         *
         * Same precedence as [fromYaml]: env vars override YAML values.
         * Missing resource is fatal here (callers asked for classpath
         * discovery and got nothing); use [fromYaml] with [java.nio.file.Files.exists]
         * if you want a tolerant fallback.
         */
        fun fromClasspath(
            resource: String = "application.yml",
            env: Map<String, String> = System.getenv(),
        ): FuranConfig = try {
            val yamlSource = io.furan.sdk.config.sources.YamlConfigSource.forClasspath(resource)
            val yaml = yamlSource.load()
            if (yaml.isEmpty() && env["FURAN_API_TOKEN"] == null) {
                throw FuranConfigException(
                    "Classpath resource '$resource' not found and FURAN_* env vars are unset",
                )
            }
            buildMerged(yaml, env)
        } catch (e: FuranConfigException) {
            throw e
        } catch (e: IllegalArgumentException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        } catch (e: IllegalStateException) {
            throw FuranConfigException(e.message ?: "Invalid FuranConfig", e)
        }

        private fun buildMerged(yaml: Map<String, Any?>, env: Map<String, String>): FuranConfig {
            fun yamlString(key: String): String? = yaml["furan.$key"]?.toString()
            fun yamlLong(key: String): Long? =
                (yaml["furan.$key"] as? Number)?.toLong() ?: yamlString(key)?.toLongOrNull()
            fun yamlInt(key: String): Int? =
                (yaml["furan.$key"] as? Number)?.toInt() ?: yamlString(key)?.toIntOrNull()
            fun yamlBool(key: String): Boolean? =
                (yaml["furan.$key"] as? Boolean)
                    ?: yamlString(key)?.let { it == "true" || it == "1" }

            // Env wins for required fields. YAML provides a fallback.
            val apiUrl = env["FURAN_API_URL"] ?: yamlString("apiUrl")
                ?: throw FuranConfigException("FURAN_API_URL or furan.apiUrl is required")
            val apiToken = env["FURAN_API_TOKEN"] ?: yamlString("apiToken")
                ?: throw FuranConfigException("FURAN_API_TOKEN or furan.apiToken is required")
            val projectId = env["FURAN_PROJECT_ID"] ?: yamlString("projectId")
                ?: throw FuranConfigException("FURAN_PROJECT_ID or furan.projectId is required")

            val viewports: List<Viewport> = run {
                val envValue = env["FURAN_VIEWPORTS"]
                if (envValue != null) return@run parseViewports(envValue)
                val yamlValue = yaml["furan.viewports"]
                if (yamlValue is List<*>) {
                    yamlValue.mapNotNull { item ->
                        if (item !is Map<*, *>) return@mapNotNull null
                        val w = (item["width"] as? Number)?.toInt() ?: return@mapNotNull null
                        val h = (item["height"] as? Number)?.toInt() ?: return@mapNotNull null
                        val dsf = (item["deviceScaleFactor"] as? Number)?.toDouble()
                        Viewport(w, h, dsf)
                    }.ifEmpty { listOf(Viewport(1280, 720)) }
                } else {
                    listOf(Viewport(1280, 720))
                }
            }

            return FuranConfig(
                apiUrl = apiUrl,
                apiToken = apiToken,
                projectId = projectId,
                buildId = env["FURAN_BUILD_ID"] ?: yamlString("buildId"),
                branchName = env["FURAN_BRANCH"] ?: yamlString("branchName") ?: "main",
                parentBranchName = (env["FURAN_PARENT_BRANCH"] ?: yamlString("parentBranchName"))
                    ?.trim()?.takeIf { it.isNotEmpty() },
                name = (env["FURAN_BUILD_NAME"] ?: yamlString("name"))?.trim()?.takeIf { it.isNotEmpty() },
                properties = parseProperties(env["FURAN_BUILD_PROPERTIES"])
                    .ifEmpty {
                        @Suppress("UNCHECKED_CAST")
                        (yaml["furan.properties"] as? Map<String, Any?>)
                            ?.mapValues { it.value.toString() } ?: emptyMap()
                    },
                viewports = viewports,
                batchSize = env["FURAN_BATCH_SIZE"]?.toIntOrNull() ?: yamlInt("batchSize") ?: 16,
                logLevel = env["FURAN_LOG_LEVEL"] ?: yamlString("logLevel") ?: "info",
                telemetryEnabled = env["FURAN_TELEMETRY"]
                    ?.let { it != "0" && it.lowercase() != "false" }
                    ?: yamlBool("telemetryEnabled") ?: true,
                caCertPath = env["FURAN_CA_CERT_PATH"] ?: yamlString("caCertPath"),
                softAssert = env["FURAN_SOFT_ASSERT"]
                    ?.let { it == "1" || it.lowercase() == "true" }
                    ?: yamlBool("softAssert") ?: false,
                pollTimeoutSeconds = env["FURAN_POLL_TIMEOUT_SECONDS"]?.toLongOrNull()
                    ?: yamlLong("pollTimeoutSeconds") ?: 60,
                pollIntervalSeconds = env["FURAN_POLL_INTERVAL_SECONDS"]?.toLongOrNull()
                    ?: yamlLong("pollIntervalSeconds") ?: 2,
                dashboardUrl = (env["FURAN_DASHBOARD_URL"] ?: yamlString("dashboardUrl"))
                    ?.trimEnd('/')?.takeIf { it.isNotEmpty() },
                failOnDiff = run {
                    val raw = env["FURAN_FAIL_ON_DIFF"] ?: yamlString("failOnDiff")
                    if (raw != null) {
                        FailOnDiff.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
                            ?: throw FuranConfigException("invalid FURAN_FAIL_ON_DIFF: $raw")
                    } else {
                        FailOnDiff.None
                    }
                },
                saveNewTests = env["FURAN_SAVE_NEW_TESTS"]?.let { it == "1" || it.lowercase() == "true" }
                    ?: yamlBool("saveNewTests") ?: false,
                os = (env["FURAN_OS"] ?: yamlString("os"))?.trim()?.takeIf { it.isNotEmpty() },
                device = (env["FURAN_DEVICE"] ?: yamlString("device"))?.trim()?.takeIf { it.isNotEmpty() },
                browser = (env["FURAN_BROWSER"] ?: yamlString("browser"))?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

        /** Parses `1280x720,375x812` into a list of [Viewport]. */
        private fun parseViewports(raw: String): List<Viewport> =
            raw.split(",")
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .map { spec ->
                    val parts = spec.lowercase().split("x")
                    require(parts.size == 2) { "Invalid viewport spec: '$spec' (expected WIDTHxHEIGHT)" }
                    val w = parts[0].trim().toIntOrNull()
                        ?: error("Invalid viewport width in '$spec'")
                    val h = parts[1].trim().toIntOrNull()
                        ?: error("Invalid viewport height in '$spec'")
                    Viewport(w, h)
                }
    }
}
