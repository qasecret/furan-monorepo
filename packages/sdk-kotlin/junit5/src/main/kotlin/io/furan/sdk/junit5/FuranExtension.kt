package io.furan.sdk.junit5

import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranConfigException
import org.junit.jupiter.api.extension.AfterAllCallback
import org.junit.jupiter.api.extension.ExtensionContext
import org.junit.jupiter.api.extension.ParameterContext
import org.junit.jupiter.api.extension.ParameterResolver

/**
 * JUnit 5 extension that loads [FuranConfig] from env once per test
 * class and parameter-resolves it (plus an optional [FuranClient])
 * into `@Test` methods.
 *
 * Usage:
 *
 * ```
 * @FuranTest
 * class CheckoutTest {
 *     @Test fun homePage(config: FuranConfig) {
 *         ChromeDriver().use { driver ->
 *             Furan(driver, config).use { furan ->
 *                 val result = furan.snapshotAndAwait("home")
 *                 assertEquals(RunStatus.PASSED, result.status)
 *             }
 *         }
 *     }
 *
 *     // Or use FuranClient directly (no driver needed):
 *     @Test fun fromBytes(client: FuranClient) = runBlocking {
 *         val run = client.createRun(...)
 *         val result = client.snapshotAndAwait(run.id, snap)
 *         assertEquals(RunStatus.PASSED, result.status)
 *     }
 * }
 * ```
 *
 * Lifecycle:
 *  - `FuranConfig` is loaded once on first parameter resolution,
 *    cached in the test class's `ExtensionContext.Store`.
 *  - `FuranClient` is constructed lazily on first injection and
 *    `close()`-ed by [afterAll] when the test class finishes.
 *    Sharing one client across `@Test` methods is the legacy Java
 *    SDK's pattern + matches the API contract: one build per test
 *    class, lazy run creation per snapshot call.
 *  - Config validation errors surface as [FuranConfigException]
 *    (PR #132 hierarchy) so users catch one exception type.
 */
class FuranExtension : ParameterResolver, AfterAllCallback {

    override fun supportsParameter(
        parameterContext: ParameterContext,
        extensionContext: ExtensionContext,
    ): Boolean {
        val type = parameterContext.parameter.type
        return type == FuranConfig::class.java || type == FuranClient::class.java
    }

    override fun resolveParameter(
        parameterContext: ParameterContext,
        extensionContext: ExtensionContext,
    ): Any {
        val store = extensionContext.getStore(NAMESPACE)
        val config = store.getOrComputeIfAbsent(
            CONFIG_KEY,
            { FuranConfig.fromEnv() },
            FuranConfig::class.java,
        )
        return when (parameterContext.parameter.type) {
            FuranConfig::class.java -> config
            FuranClient::class.java -> store.getOrComputeIfAbsent(
                CLIENT_KEY,
                { FuranClient(config, adapter = "junit5") },
                FuranClient::class.java,
            )
            else -> throw FuranConfigException(
                "FuranExtension does not resolve parameter of type ${parameterContext.parameter.type.name}",
            )
        }
    }

    override fun afterAll(context: ExtensionContext) {
        // Close the client (drains the batch + posts telemetry) if it
        // was lazily created. Config is just a data class — no close.
        val store = context.getStore(NAMESPACE)
        val client = store.get(CLIENT_KEY, FuranClient::class.java)
        client?.close()
    }

    private companion object {
        val NAMESPACE: ExtensionContext.Namespace =
            ExtensionContext.Namespace.create("io.furan.sdk.junit5.FuranExtension")
        const val CONFIG_KEY = "config"
        const val CLIENT_KEY = "client"
    }
}
