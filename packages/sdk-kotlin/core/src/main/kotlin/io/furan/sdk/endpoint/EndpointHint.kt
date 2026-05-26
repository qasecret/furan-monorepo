package io.furan.sdk.endpoint

/**
 * Caller-supplied hints to an [EndpointResolver]. All fields are
 * optional; resolvers may ignore any subset they don't understand.
 *
 *  - [region]    — preferred region (`"eu-west-1"`, `"us-east-1"`)
 *                  for region-aware resolvers; ignored by Static.
 *  - [tenantId]  — sticky-routing key for multi-tenant SaaS;
 *                  consistent-hash resolvers use it for affinity.
 *  - [service]   — logical service the request targets
 *                  (`"snapshot"`, `"control-plane"`, ...);
 *                  defaults to `"default"`.
 */
data class EndpointHint(
    val region: String? = null,
    val tenantId: String? = null,
    val service: String = "default",
)
