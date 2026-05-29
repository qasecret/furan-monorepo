package io.furan.sdk.junit5

import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranConfigException
import org.junit.jupiter.api.extension.AfterAllCallback
import org.junit.jupiter.api.extension.AfterEachCallback
import org.junit.jupiter.api.extension.BeforeEachCallback
import org.junit.jupiter.api.extension.ExtensionContext
import org.junit.jupiter.api.extension.ParameterContext
import org.junit.jupiter.api.extension.ParameterResolver

/**
 * JUnit 5 extension that auto-wires the Furan lifecycle around each `@Test`
 * method. Attach it via `@ExtendWith(FuranExtension::class)` on the test class
 * (or use the shorthand `@FuranTest` meta-annotation):
 *
 * ```kotlin
 * @ExtendWith(FuranExtension::class)
 * class CheckoutTest {
 *
 *     // Option A — extension auto-wires open/close (preferred for JUnit5):
 *     // beforeEach calls furan.open(context.displayName) and stores the
 *     // Furan in the ExtensionContext.Store. The parameter resolver returns
 *     // the stored instance. afterEach calls furan.close() on success or
 *     // furan.abort() on test failure.
 *     //
 *     // To use this path, store a Furan instance in the Store before
 *     // beforeEach runs (e.g. via @BeforeEach + store.put(FURAN_KEY, furan))
 *     // and the extension handles the rest.
 *
 *     // Option B — manual lifecycle with injected config:
 *     @Test fun homePage(config: FuranConfig) {
 *         val driver = ChromeDriver()
 *         Furan.use(config, driver, testName = "homePage") { furan ->
 *             furan.snapshot("step-1")
 *             // …
 *         }
 *         driver.quit()
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
 *  - If a `io.furan.sdk.selenium.Furan` instance is stored in the
 *    `ExtensionContext.Store` under the key [FURAN_KEY] before
 *    [beforeEach] fires (e.g. from a `@BeforeEach` that constructs
 *    `Furan(config, driver)`), the extension calls
 *    `furan.open(context.displayName)` in [beforeEach] and
 *    `furan.close()` / `furan.abort()` in [afterEach].
 *  - Config validation errors surface as [FuranConfigException]
 *    (PR #132 hierarchy) so users catch one exception type.
 *
 * Constructor order (SDK 2.0.0 / ADR-038): `Furan(config, driver)`.
 * The old `Furan(driver, config)` order was reversed in this release.
 */
class FuranExtension : ParameterResolver, AfterAllCallback, BeforeEachCallback, AfterEachCallback {

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

    /**
     * If a `Furan` (selenium adapter) instance was stored in the
     * [ExtensionContext.Store] under [FURAN_KEY] before this callback fires
     * (e.g. from a `@BeforeEach` that constructs `Furan(config, driver)`),
     * calls `furan.open(testName = context.displayName)` to start the run.
     *
     * No-op when no [FURAN_KEY] entry is present — covers the plain
     * `FuranConfig` / `FuranClient` injection path that manages its own
     * lifecycle.
     */
    override fun beforeEach(context: ExtensionContext) {
        val furan = context.getStore(NAMESPACE).get(FURAN_KEY) ?: return
        invokeMethod(furan, "open", arrayOf(String::class.java), arrayOf(context.displayName))
    }

    /**
     * Closes or aborts the open `Furan` run depending on test outcome.
     * If [ExtensionContext.executionException] is present the test failed;
     * `furan.abort()` is called to mark the run as aborted on the server.
     * Otherwise `furan.close()` is called. If [FailOnDiff.AfterEach] is
     * configured, `close()` may throw [io.furan.sdk.FuranDiffException],
     * which propagates as a JUnit5 assertion failure on the test.
     *
     * No-op when no [FURAN_KEY] entry is present.
     */
    override fun afterEach(context: ExtensionContext) {
        val furan = context.getStore(NAMESPACE).get(FURAN_KEY) ?: return
        if (context.executionException.isPresent) {
            runCatching { invokeMethod(furan, "abort", emptyArray(), emptyArray()) }
        } else {
            invokeMethod(furan, "close", emptyArray(), emptyArray())
        }
    }

    override fun afterAll(context: ExtensionContext) {
        // Close the client (drains the batch + posts telemetry) if it
        // was lazily created. Config is just a data class — no close.
        val store = context.getStore(NAMESPACE)
        val client = store.get(CLIENT_KEY, FuranClient::class.java)
        client?.close()
    }

    companion object {
        val NAMESPACE: ExtensionContext.Namespace =
            ExtensionContext.Namespace.create("io.furan.sdk.junit5.FuranExtension")
        const val CONFIG_KEY = "config"
        const val CLIENT_KEY = "client"

        /**
         * Store key under which a `io.furan.sdk.selenium.Furan` instance
         * should be registered in the `ExtensionContext.Store` when the
         * caller wants the extension to manage `open()`/`close()` lifecycle.
         *
         * Typical usage in a test class:
         * ```kotlin
         * @FuranTest
         * class MyTest {
         *     private lateinit var driver: WebDriver
         *
         *     @BeforeEach
         *     fun setup(config: FuranConfig, context: ExtensionContext) {
         *         driver = ChromeDriver()
         *         val furan = Furan(config, driver)
         *         context.getStore(FuranExtension.NAMESPACE).put(FuranExtension.FURAN_KEY, furan)
         *     }
         *
         *     @Test
         *     fun myTest() {
         *         // furan.open() already called by FuranExtension.beforeEach
         *         val furan = context.getStore(...).get(FURAN_KEY) as Furan
         *         furan.snapshot("step-1")
         *         // furan.close() called by FuranExtension.afterEach
         *     }
         * }
         * ```
         */
        const val FURAN_KEY = "furan"

        /**
         * Invoke a method on [target] by reflection. Used to call
         * `open`/`close`/`abort` on `io.furan.sdk.selenium.Furan` without
         * taking a compile-time dependency on the selenium module — the
         * junit5 module is browser-agnostic and only requires `:core`.
         */
        private fun invokeMethod(
            target: Any,
            name: String,
            paramTypes: Array<Class<*>>,
            args: Array<Any?>,
        ) {
            target.javaClass.getMethod(name, *paramTypes).invoke(target, *args)
        }
    }
}
