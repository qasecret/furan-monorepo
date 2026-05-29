package io.furan.sdk.junit5

import org.junit.jupiter.api.extension.ExtendWith

/**
 * Marks a test class as Furan-aware. Activates [FuranExtension] so
 * `@Test` methods can declare `FuranConfig` or `FuranClient`
 * parameters and have them auto-resolved.
 *
 * Equivalent to writing `@ExtendWith(FuranExtension::class)`
 * directly — the meta-annotation form is the canonical legacy
 * Java SDK pattern.
 *
 * ```kotlin
 * @FuranTest
 * class CheckoutTest {
 *
 *     // Option B — injected config + Furan.use for lifecycle:
 *     @Test fun homePage(config: FuranConfig) {
 *         val driver = ChromeDriver()
 *         Furan.use(config, driver, testName = "homePage") { furan ->
 *             furan.snapshot("step-1")
 *         }
 *         driver.quit()
 *     }
 * }
 * ```
 *
 * SDK 2.0.0 constructor order: `Furan(config, driver)`.
 * The old `Furan(driver, config)` order was reversed in this release.
 */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
@ExtendWith(FuranExtension::class)
annotation class FuranTest
