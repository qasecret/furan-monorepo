package io.furan.sdk.junit5

import io.furan.sdk.FailOnDiff
import io.furan.sdk.FuranClient
import io.furan.sdk.FuranConfig
import io.furan.sdk.FuranConfigException
import io.furan.sdk.FuranSuiteException
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
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
            val result = invokeMethod(furan, "close", emptyArray(), emptyArray())
            // Tier 1.5: stash each successful close()'s RunResult on the
            // class-level store so getSuiteResult() can aggregate across
            // the suite. `Furan.close()` returns RunResult? (null when no
            // run was open), so we no-op on null.
            (result as? RunResult)?.let { captureRunResult(context, it) }
        }
    }

    override fun afterAll(context: ExtensionContext) {
        // Close the client (drains the batch + posts telemetry) if it
        // was lazily created. Config is just a data class — no close.
        val store = context.getStore(NAMESPACE)
        store.get(CLIENT_KEY, FuranClient::class.java)?.close()
        val config = store.get(CONFIG_KEY, FuranConfig::class.java)
        if (config?.failOnDiff == FailOnDiff.AfterAll) {
            suiteFailure(getSuiteResult(context))?.let { throw it }
        }
    }

    companion object {
        val NAMESPACE: ExtensionContext.Namespace =
            ExtensionContext.Namespace.create("io.furan.sdk.junit5.FuranExtension")
        const val CONFIG_KEY = "config"
        const val CLIENT_KEY = "client"

        /**
         * Tier 1.5: store key for the per-class accumulator of
         * [RunResult]s captured by [afterEach]. Lives on the root /
         * class-level store so it survives across @Test methods.
         */
        const val RESULTS_KEY = "suite-results"

        /**
         * Tier 1.5 — aggregate every [RunResult] captured by the
         * extension over the lifetime of this test class into a single
         * [SuiteResult] (mirrors Applitools' `runner.getAllTestResults`).
         *
         * Returns an empty SuiteResult when no runs have been recorded
         * yet — e.g. when the test class hasn't started, or every @Test
         * went through the `FuranClient` injection path (which manages
         * its own lifecycle without the extension's open/close hooks).
         *
         * Thread-safe: the accumulator is synchronized on its own
         * monitor, and the returned list is a snapshot copy.
         */
        @JvmStatic
        fun getSuiteResult(context: ExtensionContext): SuiteResult {
            val store = context.root.getStore(NAMESPACE)
            @Suppress("UNCHECKED_CAST")
            val results = store.get(RESULTS_KEY) as? MutableList<RunResult>
            return snapshotResults(results)
        }

        /**
         * Tier 1.5: append a completed RunResult to the class-level
         * accumulator. Visible to [afterEach] (same file). Synchronizes
         * on the list so parallel @Test execution (JUnit5
         * `junit.jupiter.execution.parallel.enabled`) doesn't drop
         * entries.
         */
        @Suppress("UNCHECKED_CAST")
        internal fun captureRunResult(context: ExtensionContext, result: RunResult) {
            val store = context.root.getStore(NAMESPACE)
            val results = store.getOrComputeIfAbsent(
                RESULTS_KEY,
                { mutableListOf<RunResult>() },
                MutableList::class.java,
            ) as MutableList<RunResult>
            appendResult(results, result)
        }

        /**
         * Pure helper for [captureRunResult] — exposed so tests can
         * exercise the accumulator semantics (thread-safety, append,
         * snapshot) without standing up a full JUnit5 [ExtensionContext].
         */
        internal fun appendResult(list: MutableList<RunResult>, result: RunResult) {
            synchronized(list) { list.add(result) }
        }

        /**
         * Pure helper for [getSuiteResult] — exposed so tests can
         * exercise the snapshot semantics without an [ExtensionContext].
         * Null input returns an empty suite (matches the Store-empty
         * code path in the public API).
         */
        internal fun snapshotResults(list: MutableList<RunResult>?): SuiteResult {
            if (list == null) return SuiteResult(emptyList())
            synchronized(list) { return SuiteResult(list.toList()) }
        }

        /** AfterAll decision: an exception to throw if the suite has failures, else null. */
        @JvmStatic
        fun suiteFailure(suite: SuiteResult): FuranSuiteException? =
            if (suite.hasFailures) FuranSuiteException(suite) else null

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
         * Invoke a method on [target] by reflection and return its result
         * (or `null` if void). Used to call `open`/`close`/`abort` on
         * `io.furan.sdk.selenium.Furan` without taking a compile-time
         * dependency on the selenium module — the junit5 module is
         * browser-agnostic and only requires `:core`.
         */
        private fun invokeMethod(
            target: Any,
            name: String,
            paramTypes: Array<Class<*>>,
            args: Array<Any?>,
        ): Any? = target.javaClass.getMethod(name, *paramTypes).invoke(target, *args)
    }
}
