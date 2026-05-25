package io.furan.sdk.junit5

import org.junit.jupiter.api.extension.ExtendWith

/**
 * Marks a test class as Furan-aware. Activates [FuranExtension] so
 * `@Test` methods can declare `FuranConfig` or `FuranClient`
 * parameters and have them auto-resolved.
 *
 * Equivalent to writing `@ExtendWith(FuranExtension::class)`
 * directly — the meta-annotation form is the canonical legacy
 * Java SDK pattern (mirrors the planned `furan-junit5` shape from
 * the 2026-05-24 Java-SDK-parity comparison).
 *
 * ```
 * @FuranTest
 * class CheckoutTest {
 *     @Test fun homePage(config: FuranConfig) {
 *         // ...
 *     }
 * }
 * ```
 */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
@ExtendWith(FuranExtension::class)
annotation class FuranTest
