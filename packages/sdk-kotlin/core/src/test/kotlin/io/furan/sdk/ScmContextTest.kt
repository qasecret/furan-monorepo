package io.furan.sdk

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class ScmContextTest {
    private val headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val mergeSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    /** A GitHub Actions `pull_request` event file, as the runner writes it. */
    private val prEvent = """
        {"action":"synchronize","number":42,
         "pull_request":{"number":42,"head":{"sha":"$headSha","ref":"feature/x"},
                         "base":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}}
    """.trimIndent()

    private val actions = mapOf(
        "GITHUB_ACTIONS" to "true",
        "GITHUB_REPOSITORY" to "acme/site",
        "GITHUB_SHA" to mergeSha,
    )

    private fun files(vararg entries: Pair<String, String>): (String) -> String? {
        val map = entries.toMap()
        return { path -> map[path] }
    }

    @Test
    fun `nothing set means nothing sent`() {
        assertEquals(ScmContext(), ScmContext.fromEnv(emptyMap(), files()))
    }

    @Test
    fun `explicit FURAN variables are used as given, sha lower-cased`() {
        val scm = ScmContext.fromEnv(
            mapOf(
                "FURAN_REPO" to "acme/site",
                "FURAN_PR_NUMBER" to "7",
                "FURAN_COMMIT_SHA" to "DEADBEEF1234",
            ),
            files(),
        )
        assertEquals(ScmContext("acme/site", 7, "deadbeef1234"), scm)
    }

    @Test
    fun `a push build on GitHub Actions has the repo and GITHUB_SHA and no pull request`() {
        val scm = ScmContext.fromEnv(actions + ("GITHUB_EVENT_NAME" to "push"), files())
        assertEquals(ScmContext("acme/site", null, mergeSha), scm)
    }

    @Test
    fun `a pull_request build reports the PR head sha, not the merge commit`() {
        // GITHUB_SHA is the synthetic merge commit on pull_request events. A
        // status posted to it never shows on the pull request.
        val scm = ScmContext.fromEnv(
            actions + mapOf(
                "GITHUB_EVENT_NAME" to "pull_request",
                "GITHUB_EVENT_PATH" to "/event.json",
            ),
            files("/event.json" to prEvent),
        )
        assertEquals(ScmContext("acme/site", 42, headSha), scm)
    }

    @Test
    fun `pull_request_target is read the same way`() {
        val scm = ScmContext.fromEnv(
            actions + mapOf(
                "GITHUB_EVENT_NAME" to "pull_request_target",
                "GITHUB_EVENT_PATH" to "/event.json",
            ),
            files("/event.json" to prEvent),
        )
        assertEquals(headSha, scm.commitSha)
        assertEquals(42, scm.prNumber)
    }

    @Test
    fun `an unreadable event file falls back to GITHUB_REF for the number and GITHUB_SHA`() {
        val scm = ScmContext.fromEnv(
            actions + mapOf(
                "GITHUB_EVENT_NAME" to "pull_request",
                "GITHUB_EVENT_PATH" to "/missing.json",
                "GITHUB_REF" to "refs/pull/17/merge",
            ),
            files(),
        )
        assertEquals(ScmContext("acme/site", 17, mergeSha), scm)
    }

    @Test
    fun `an event file that is not JSON is ignored, not thrown`() {
        val scm = ScmContext.fromEnv(
            actions + mapOf(
                "GITHUB_EVENT_NAME" to "pull_request",
                "GITHUB_EVENT_PATH" to "/event.json",
            ),
            files("/event.json" to "{not json"),
        )
        assertEquals(ScmContext("acme/site", null, mergeSha), scm)
    }

    @Test
    fun `explicit FURAN variables win over GitHub Actions per field`() {
        val scm = ScmContext.fromEnv(
            actions + mapOf(
                "GITHUB_EVENT_NAME" to "pull_request",
                "GITHUB_EVENT_PATH" to "/event.json",
                "FURAN_REPO" to "other/repo",
                "FURAN_COMMIT_SHA" to "1234567",
            ),
            files("/event.json" to prEvent),
        )
        // repo and sha are explicit; the PR number still comes from the event.
        assertEquals(ScmContext("other/repo", 42, "1234567"), scm)
    }

    @Test
    fun `GitHub Actions variables are ignored when not running on Actions`() {
        val scm = ScmContext.fromEnv(
            mapOf(
                "GITHUB_REPOSITORY" to "acme/site",
                "GITHUB_SHA" to mergeSha,
                "GITHUB_EVENT_NAME" to "pull_request",
            ),
            files(),
        )
        assertEquals(ScmContext(), scm)
    }

    @Test
    fun `malformed values are dropped rather than sent`() {
        val scm = ScmContext.fromEnv(
            mapOf(
                "FURAN_REPO" to "not-a-slug",
                "FURAN_PR_NUMBER" to "0",
                "FURAN_COMMIT_SHA" to "xyz",
            ),
            files(),
        )
        assertEquals(ScmContext(), scm)
        assertNull(ScmContext.fromEnv(mapOf("FURAN_PR_NUMBER" to "12abc"), files()).prNumber)
        assertNull(ScmContext.fromEnv(mapOf("FURAN_REPO" to "a/b/c"), files()).repo)
        assertNull(ScmContext.fromEnv(mapOf("FURAN_COMMIT_SHA" to "abc12"), files()).commitSha)
    }

    @Test
    fun `blank values count as unset`() {
        assertEquals(
            ScmContext(),
            ScmContext.fromEnv(
                mapOf("FURAN_REPO" to "  ", "FURAN_PR_NUMBER" to "", "FURAN_COMMIT_SHA" to " "),
                files(),
            ),
        )
    }

    @Test
    fun `the POST runs body carries the context only when set`() {
        val full = buildCreateRunBody(
            projectId = "p",
            buildId = "b",
            name = "n",
            branchName = "main",
            parentBranchName = null,
            scm = ScmContext("acme/site", 42, headSha),
        )
        assertEquals("acme/site", full.getValue("repo").jsonPrimitive.content)
        assertEquals(42, full.getValue("prNumber").jsonPrimitive.int)
        assertEquals(headSha, full.getValue("commitSha").jsonPrimitive.content)

        val bare = buildCreateRunBody("p", "b", "n", "main", null, ScmContext())
        assertFalse(bare.containsKey("repo"))
        assertFalse(bare.containsKey("prNumber"))
        assertFalse(bare.containsKey("commitSha"))
        // The existing fields are unchanged.
        assertEquals(JsonPrimitive("p"), bare.getValue("projectId"))
        assertEquals(setOf("projectId", "buildId", "name", "branchName"), bare.jsonObject.keys)
    }
}
