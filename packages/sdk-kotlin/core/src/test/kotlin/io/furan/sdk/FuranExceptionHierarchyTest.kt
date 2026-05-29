package io.furan.sdk

import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.SnapshotResult
import io.furan.sdk.transport.HttpException
import io.furan.sdk.transport.RetriableException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Audits the FuranException hierarchy. The contract is: every SDK-
 * thrown exception extends FuranException so user code can catch one
 * branch to handle "anything the SDK can throw."
 */
class FuranExceptionHierarchyTest {
    @Test
    fun `FuranAssertionException is a FuranException`() {
        val r = SnapshotResult(
            runId = "r1",
            buildId = "b1",
            status = RunStatus.UNRESOLVED,
        )
        val ex = FuranAssertionException(r)
        assertTrue(ex is FuranException, "AssertionException must extend FuranException")
    }

    @Test
    fun `FuranTimeoutException is a FuranException`() {
        val ex = FuranTimeoutException(
            runId = "r1",
            lastStatus = RunStatus.RUNNING,
            timeoutSeconds = 60,
        )
        assertTrue(ex is FuranException, "TimeoutException must extend FuranException")
    }

    @Test
    fun `FuranConfigException is a FuranException`() {
        val ex = FuranConfigException("missing FURAN_API_URL")
        assertTrue(ex is FuranException)
    }

    @Test
    fun `FuranTransportException is a FuranException`() {
        val ex = FuranTransportException(
            statusCode = 503,
            responseBody = "Bad Gateway",
            message = "HTTP 503: Bad Gateway",
        )
        assertTrue(ex is FuranException)
    }

    @Test
    fun `transport-layer HttpException is a FuranTransportException`() {
        // Locked-down inheritance: HttpException existed before #4 as a
        // bare RuntimeException, so existing transport callers catching
        // it keep working. Now it's also catchable as the typed
        // FuranTransportException + FuranException.
        val ex = HttpException(statusCode = 401, responseBody = "{\"error\":\"unauthenticated\"}")
        assertTrue(ex is FuranTransportException)
        assertTrue(ex is FuranException)
        assertEquals(401, ex.statusCode)
        assertEquals("{\"error\":\"unauthenticated\"}", ex.responseBody)
        assertTrue(ex.isClientError)
        assertFalse(ex.isServerError)
    }

    @Test
    fun `transport-layer RetriableException is a FuranTransportException`() {
        val ex = RetriableException("HTTP 503: upstream timeout")
        assertTrue(ex is FuranTransportException)
        assertTrue(ex is FuranException)
        // Retriable doesn't carry a numeric statusCode (the retry layer
        // catches before unwinding); isServerError still true via the
        // "statusCode is null" branch since 5xx + null are equivalent
        // failure modes for user-side handling.
        assertNull(ex.statusCode)
        assertTrue(ex.isServerError)
        assertFalse(ex.isClientError)
    }

    @Test
    fun `FuranTransportException classifies client vs server errors`() {
        val cli = FuranTransportException(statusCode = 404, responseBody = null, message = "")
        assertTrue(cli.isClientError)
        assertFalse(cli.isServerError)

        val srv = FuranTransportException(statusCode = 502, responseBody = null, message = "")
        assertTrue(srv.isServerError)
        assertFalse(srv.isClientError)

        val unknown = FuranTransportException(statusCode = null, responseBody = null, message = "")
        // Null statusCode (pre-flight failure / unknown) buckets as
        // server-error so test infra can retry it the same way as 5xx.
        assertTrue(unknown.isServerError)
        assertFalse(unknown.isClientError)
    }

    @Test
    fun `FuranDiffException is a FuranException carrying RunResult`() {
        val runResult = RunResult(
            runId = "run-1",
            status = RunStatus.UNRESOLVED,
            checkpointCount = 2,
        )
        val ex = FuranDiffException(runResult)
        assertTrue(ex is FuranException)
        assertEquals(runResult, ex.runResult)
        assertTrue(ex.message?.contains("run-1") == true)
        assertTrue(ex.message?.contains("2") == true)
    }

    @Test
    fun `FuranDiffException allows custom message override`() {
        val runResult = RunResult(runId = "r", status = RunStatus.FAILED, checkpointCount = 1)
        val ex = FuranDiffException(runResult, "custom message")
        assertEquals("custom message", ex.message)
    }

    @Test
    fun `FuranConfigException preserves the cause chain`() {
        val cause = IllegalArgumentException("batchSize must be >= 1")
        val ex = FuranConfigException("Invalid FuranConfig", cause)
        assertEquals(cause, ex.cause)
        // Useful when a test wants to inspect the underlying validation
        // without rebuilding the config.
        assertNotNull(ex.cause as? IllegalArgumentException)
    }
}
