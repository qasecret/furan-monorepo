package io.furan.sdk

data class Viewport(val width: Int, val height: Int, val deviceScaleFactor: Double? = null)

data class FuranConfig(
    val apiUrl: String,
    val apiToken: String,
    val projectId: String,
    val buildId: String? = null,
    val branchName: String = "main",
    val viewports: List<Viewport> = listOf(Viewport(1280, 720)),
    val batchSize: Int = 16,
    val logLevel: String = "info",
    val telemetryEnabled: Boolean = true,
    val caCertPath: String? = null,
) {
    init {
        require(apiUrl.isNotBlank()) { "apiUrl must be non-blank" }
        require(apiToken.isNotBlank()) { "apiToken must be non-blank" }
        require(projectId.isNotBlank()) { "projectId must be non-blank" }
        require(batchSize >= 1) { "batchSize must be >= 1" }
    }

    companion object {
        /**
         * Build a config from FURAN_* env vars. Throws [IllegalStateException] if required vars are missing.
         *
         * FURAN_VIEWPORTS uses a compact comma-separated `WIDTHxHEIGHT` format, e.g.
         * `1280x720,375x812`. (Defensible deviation from the spec's JSON-array sketch:
         * the spec note explicitly authorizes this simpler format. Avoids pulling
         * kotlinx-serialization into config bootstrap.)
         */
        fun fromEnv(env: Map<String, String> = System.getenv()): FuranConfig {
            val apiUrl = env["FURAN_API_URL"] ?: error("FURAN_API_URL is required")
            val apiToken = env["FURAN_API_TOKEN"] ?: error("FURAN_API_TOKEN is required")
            val projectId = env["FURAN_PROJECT_ID"] ?: error("FURAN_PROJECT_ID is required")
            return FuranConfig(
                apiUrl = apiUrl,
                apiToken = apiToken,
                projectId = projectId,
                buildId = env["FURAN_BUILD_ID"],
                branchName = env["FURAN_BRANCH"] ?: "main",
                viewports = env["FURAN_VIEWPORTS"]?.let(::parseViewports) ?: listOf(Viewport(1280, 720)),
                batchSize = env["FURAN_BATCH_SIZE"]?.toIntOrNull() ?: 16,
                logLevel = env["FURAN_LOG_LEVEL"] ?: "info",
                telemetryEnabled = env["FURAN_TELEMETRY"]?.let { it != "0" && it.lowercase() != "false" } ?: true,
                caCertPath = env["FURAN_CA_CERT_PATH"],
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
