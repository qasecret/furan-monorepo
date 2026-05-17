package io.furan.sdk.dto

import kotlinx.serialization.Serializable

/**
 * Request body for POST /api/v1/projects/:id/builds.
 *
 * Mirrors `createBody` zod schema in `apps/api/src/routes/builds.ts`:
 * all fields optional; the projectId is bound via the route param, not the body.
 * `projectId` is carried here for the SDK to pick which route to hit; it is NOT
 * serialized into the JSON body sent over the wire (see HttpTransport.createBuild).
 */
@Serializable
data class CreateBuildRequest(
    val ciBuildId: String? = null,
    val number: Int? = null,
    val branchName: String? = null,
)

/**
 * Response body for POST /api/v1/projects/:id/builds and listing endpoints.
 * Mirrors the `builds` Drizzle row in `packages/db/src/schema/builds.ts`.
 */
@Serializable
data class BuildResponse(
    val id: String,
    val projectId: String,
    val userId: String? = null,
    val branchName: String? = null,
    val ciBuildId: String? = null,
    val number: Int? = null,
    val status: String? = null,
    val isRunning: Boolean = false,
    val environment: String = "default",
    val createdAt: String? = null,
    val updatedAt: String? = null,
)
