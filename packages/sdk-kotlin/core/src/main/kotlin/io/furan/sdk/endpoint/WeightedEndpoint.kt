package io.furan.sdk.endpoint

/**
 * A single weighted candidate for [WeightedEndpointResolver]. The
 * [weight] controls the relative likelihood that this endpoint is
 * picked on each `resolve` call; higher = more traffic. The [tags]
 * are free-form metadata (e.g. `"region" to "eu"`) for diagnostics
 * and downstream filtering — they don't affect selection in
 * [WeightedEndpointResolver].
 *
 * Construction validates eagerly so misconfiguration surfaces at
 * bootstrap time rather than the first request.
 */
data class WeightedEndpoint(
    val url: String,
    val weight: Int,
    val tags: Map<String, String> = emptyMap(),
) {
    init {
        require(url.isNotBlank()) { "WeightedEndpoint.url must not be blank" }
        require(weight > 0) { "WeightedEndpoint.weight must be > 0 (got $weight)" }
    }
}
