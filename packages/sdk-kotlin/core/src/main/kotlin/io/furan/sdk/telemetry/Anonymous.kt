package io.furan.sdk.telemetry

import kotlinx.serialization.Serializable
import java.util.concurrent.atomic.AtomicLong

/**
 * Anonymous SDK telemetry payload. NO PII, NO project/run/user IDs, NO stack traces.
 * Only the SDK string identity (sdk + version + adapter), the host OS family, and
 * aggregate success/error counts for the lifetime of the [AnonymousCounter].
 *
 * Posted opportunistically at FuranClient.close() when telemetryEnabled = true.
 */
@Serializable
data class SdkTelemetryPayload(
    val sdk: String = "kotlin",
    val version: String,
    val adapter: String,
    val os: String,
    val success: Long,
    val errors: Long,
)

/** Thread-safe counter for SDK success/error events. */
class AnonymousCounter(
    private val sdkVersion: String,
    private val adapter: String,
) {
    private val success = AtomicLong(0)
    private val errors = AtomicLong(0)

    fun recordSuccess() {
        success.incrementAndGet()
    }

    fun recordError() {
        errors.incrementAndGet()
    }

    fun snapshot(): SdkTelemetryPayload = SdkTelemetryPayload(
        version = sdkVersion,
        adapter = adapter,
        os = (System.getProperty("os.name") ?: "unknown").lowercase().take(20),
        success = success.get(),
        errors = errors.get(),
    )
}
