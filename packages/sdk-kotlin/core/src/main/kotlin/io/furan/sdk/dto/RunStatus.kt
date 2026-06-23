package io.furan.sdk.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * Typed mirror of the server's `run_status` Postgres enum + the legacy
 * shapes the diff worker still emits. Wire strings match the values used
 * by the API's tRPC + REST surfaces verbatim — see
 * `packages/db/src/schema/test_runs.ts` for the canonical list.
 *
 * Use [fromWire] when decoding from arbitrary strings: unknown / future
 * server values map to [UNRESOLVED] rather than throwing, so a server
 * that introduces a new terminal status does not crash old SDK clients.
 * [TolerantSerializer] applies the same fallback at deserialization time.
 */
@Serializable(with = RunStatus.TolerantSerializer::class)
enum class RunStatus(val wire: String) {
    @SerialName("new")
    NEW("new"),

    @SerialName("running")
    RUNNING("running"),

    @SerialName("passed")
    PASSED("passed"),

    @SerialName("unresolved")
    UNRESOLVED("unresolved"),

    @SerialName("failed")
    FAILED("failed"),

    @SerialName("aborted")
    ABORTED("aborted"),

    @SerialName("empty")
    EMPTY("empty");

    /** True once the diff worker is done with this run — no more state changes. */
    fun isTerminal(): Boolean = this != NEW && this != RUNNING

    /**
     * Terminal statuses that represent a problem the test author cares about.
     * Used by `snapshotAndAwait()` to decide whether to throw
     * [io.furan.sdk.FuranAssertionException] when softAssert is off.
     */
    fun isFailure(): Boolean = this == UNRESOLVED || this == FAILED || this == ABORTED

    /** The one terminal status the SDK treats as success. */
    fun isPassing(): Boolean = this == PASSED

    companion object {
        /**
         * Maps a wire string to a [RunStatus]. Unknown values fall back to
         * [UNRESOLVED] so a forward-compatible SDK keeps working when the
         * server adds new states. Case-sensitive (Postgres enum values are
         * lowercase).
         */
        fun fromWire(s: String): RunStatus =
            entries.firstOrNull { it.wire == s } ?: UNRESOLVED
    }

    /**
     * Custom serializer: serializes to the wire string, deserializes via
     * [fromWire] so unknown server-side values don't throw. The default
     * @Serializable enum serializer is strict — it would raise
     * SerializationException for any string outside our known set,
     * which would break SDK clients on a server that adds a new state.
     */
    object TolerantSerializer : KSerializer<RunStatus> {
        override val descriptor: SerialDescriptor =
            PrimitiveSerialDescriptor("io.furan.sdk.dto.RunStatus", PrimitiveKind.STRING)

        override fun serialize(encoder: Encoder, value: RunStatus) {
            encoder.encodeString(value.wire)
        }

        override fun deserialize(decoder: Decoder): RunStatus =
            fromWire(decoder.decodeString())
    }
}
