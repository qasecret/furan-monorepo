package io.furan.sdk.config

/**
 * Marker annotation for config properties that must never be rendered
 * verbatim in logs, diagnostics dumps, or `toString()`. The annotation
 * is consumed by [DefaultSecretMasker] together with a name-pattern
 * fallback so older properties (e.g. `apiToken`) are masked even
 * without the annotation.
 */
@Target(AnnotationTarget.PROPERTY, AnnotationTarget.VALUE_PARAMETER)
@Retention(AnnotationRetention.RUNTIME)
annotation class Secret

/**
 * Strategy for masking secret values in diagnostic output. Default impl
 * uses a deny-list of leaf-key tokens (apiKey, apiToken, password,
 * secret, signatureSecret, ...) matched case-insensitively against the
 * final camelCase token of the dotted key.
 */
interface SecretMasker {
    fun mask(values: Map<String, Any?>): Map<String, Any?>
    fun maskProvenance(provenance: Map<String, ConfigValue<*>>): Map<String, ConfigValue<*>>
}

object DefaultSecretMasker : SecretMasker {

    private val SECRET_LEAF_TOKENS = setOf(
        "apikey", "apitoken", "token", "password", "secret",
        "signaturesecret", "credentials", "privatekey",
    )

    override fun mask(values: Map<String, Any?>): Map<String, Any?> =
        values.mapValues { (key, value) ->
            if (value != null && isSecretKey(key)) MASK else value
        }

    override fun maskProvenance(
        provenance: Map<String, ConfigValue<*>>,
    ): Map<String, ConfigValue<*>> =
        provenance.mapValues { (key, cv) ->
            if (cv.value != null && isSecretKey(key)) {
                @Suppress("UNCHECKED_CAST")
                ConfigValue(MASK, cv.source, cv.priority) as ConfigValue<*>
            } else cv
        }

    private fun isSecretKey(dottedKey: String): Boolean {
        val leaf = dottedKey.substringAfterLast('.').lowercase()
        return leaf in SECRET_LEAF_TOKENS
    }

    const val MASK = "******"
}
