package io.furan.sdk

data class Viewport(val width: Int, val height: Int, val deviceScaleFactor: Double? = null)

data class FuranConfig(
    val apiUrl: String,
    val apiToken: String,
    val projectId: String,
    val buildId: String? = null,
    val branchName: String = "main",
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
