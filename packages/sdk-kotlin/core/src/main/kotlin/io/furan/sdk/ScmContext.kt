package io.furan.sdk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Which repository, pull request and commit a run was made for. Sent on
 * `POST /runs` so the Furan GitHub App can comment on the pull request and set
 * the `furan/baselines` commit status. Every field is optional: with none of
 * them a run is simply never reported to GitHub.
 *
 * Resolved per field, first match wins:
 *  1. the explicit variable: `FURAN_REPO` (`owner/name`), `FURAN_PR_NUMBER`,
 *     `FURAN_COMMIT_SHA`. This is how Jenkins, GitLab CI and other systems
 *     that build a GitHub repository pass them.
 *  2. GitHub Actions (`GITHUB_ACTIONS=true`): `GITHUB_REPOSITORY`; on
 *     `pull_request` / `pull_request_target` events the pull request number
 *     and **head** commit from the event file at `GITHUB_EVENT_PATH` (the
 *     number falls back to `GITHUB_REF` = `refs/pull/<n>/merge`); otherwise
 *     `GITHUB_SHA`.
 *
 * The head commit matters: `GITHUB_SHA` on a `pull_request` event is the
 * synthetic merge commit, and a status posted to it never shows on the pull
 * request.
 *
 * A malformed value is dropped (an explicit one with a one-line notice), never
 * thrown: an optional hint must not fail a test run.
 */
data class ScmContext(
    /** `owner/name`. */
    val repo: String? = null,
    val prNumber: Int? = null,
    /** Lower-case hex, 7 to 64 characters. */
    val commitSha: String? = null,
) {
    companion object {
        private val REPO = Regex("^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
        private val SHA = Regex("^[0-9a-fA-F]{7,64}$")
        private val PULL_REF = Regex("^refs/pull/(\\d+)/")

        private fun parseRepo(raw: String): String? = raw.takeIf { REPO.matches(it) }
        private fun parsePr(raw: String): Int? = raw.toIntOrNull()?.takeIf { it >= 1 }
        private fun parseSha(raw: String): String? =
            raw.takeIf { SHA.matches(it) }?.lowercase()

        /** The explicit variable, trimmed; a malformed one is reported and ignored. */
        private fun <T : Any> explicit(
            env: Map<String, String>,
            name: String,
            parse: (String) -> T?,
        ): T? {
            val raw = env[name]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val parsed = parse(raw)
            if (parsed == null) println("[furan-sdk] Ignoring malformed $name: '$raw'")
            return parsed
        }

        private fun <T : Any> auto(raw: String?, parse: (String) -> T?): T? =
            raw?.trim()?.takeIf { it.isNotEmpty() }?.let(parse)

        private class PullRequestEvent(val number: Int?, val headSha: String?)

        private fun readPullRequestEvent(
            path: String?,
            readFile: (String) -> String?,
        ): PullRequestEvent? {
            val text = path?.takeIf { it.isNotBlank() }?.let(readFile) ?: return null
            return try {
                val pr = Json.parseToJsonElement(text).jsonObject["pull_request"]?.jsonObject
                pr?.let {
                    PullRequestEvent(
                        number = it["number"]?.jsonPrimitive?.intOrNull,
                        headSha = it["head"]?.jsonObject?.get("sha")?.jsonPrimitive?.contentOrNull,
                    )
                }
            } catch (e: Exception) {
                null
            }
        }

        private fun readTextOrNull(path: String): String? =
            runCatching { java.io.File(path).readText() }.getOrNull()

        /**
         * Resolve the context from [env] (the process environment by default).
         * [readFile] reads the GitHub Actions event file; tests inject it.
         */
        fun fromEnv(
            env: Map<String, String> = System.getenv(),
            readFile: (String) -> String? = ::readTextOrNull,
        ): ScmContext {
            val onActions = env["GITHUB_ACTIONS"]?.trim()?.lowercase() == "true"
            val isPullRequest = onActions &&
                env["GITHUB_EVENT_NAME"]?.startsWith("pull_request") == true
            val event = if (isPullRequest) {
                readPullRequestEvent(env["GITHUB_EVENT_PATH"], readFile)
            } else {
                null
            }

            val repo = explicit(env, "FURAN_REPO", ::parseRepo)
                ?: if (onActions) auto(env["GITHUB_REPOSITORY"], ::parseRepo) else null

            val prNumber = explicit(env, "FURAN_PR_NUMBER", ::parsePr)
                ?: event?.number?.takeIf { it >= 1 }
                ?: if (isPullRequest) {
                    auto(env["GITHUB_REF"]) { ref ->
                        PULL_REF.find(ref)?.groupValues?.get(1)?.let(::parsePr)
                    }
                } else {
                    null
                }

            val commitSha = explicit(env, "FURAN_COMMIT_SHA", ::parseSha)
                ?: auto(event?.headSha, ::parseSha)
                ?: if (onActions) auto(env["GITHUB_SHA"], ::parseSha) else null

            return ScmContext(repo = repo, prNumber = prNumber, commitSha = commitSha)
        }
    }
}
