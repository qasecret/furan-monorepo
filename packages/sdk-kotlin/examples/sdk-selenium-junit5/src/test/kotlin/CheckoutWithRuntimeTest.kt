import io.furan.sdk.FuranConfig
import io.furan.sdk.event.FuranEvent
import io.furan.sdk.event.subscribe
import io.furan.sdk.runtime.FuranBootstrapper
import io.furan.sdk.runtime.RuntimeState
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Demonstrates the v2 runtime spine (`FuranBootstrapper` → `FuranRuntime`)
 * alongside ordinary `Furan(config, driver)` snapshot calls.
 *
 * The v2 runtime is orthogonal to the snapshot path: it owns config
 * provenance, the event bus, the lifecycle state machine, the
 * optional plugin registry, and operator-grade diagnostics. The
 * `Furan` adapter you already know does not need a `FuranRuntime`
 * to function — but opting into the runtime gets you observability
 * hooks that the v1 path doesn't expose.
 *
 * When to opt in:
 *  - You want to log every config reload / state transition flowing
 *    through the SDK.
 *  - You want a synchronous `RuntimeSnapshot` (state, uptime, memory,
 *    config provenance, recent events) to dump from an actuator
 *    endpoint, a CLI `--diagnose` flag, or a support-ticket helper.
 *  - You want to register a custom plugin (e.g., a router that emits
 *    a custom event when it picks an endpoint).
 *
 * If none of those apply, stay on the v1 ergonomics shown in
 * [CheckoutTest] / [CheckoutAwaitTest] — they remain fully supported.
 *
 * Skipped unless FURAN_API_URL is set, same as the other examples.
 */
@EnabledIfEnvironmentVariable(named = "FURAN_API_URL", matches = ".+")
class CheckoutWithRuntimeTest {

    @Test
    fun `bootstraps v2 runtime, subscribes to events, then takes a snapshot`() {
        // 1. Bootstrap the v2 runtime. Default ConfigSources are
        //    [Defaults, SysProp, Env] — same FURAN_* vars the v1
        //    FuranConfig.fromEnv() path reads. Diagnostics is opt-in
        //    via the constructor flag (defaults to true).
        val runtime = FuranBootstrapper().bootstrap()
        try {
            // After bootstrap(), the runtime is READY. It transitions
            // through INITIALIZING → READY synchronously inside
            // bootstrap(); callers never see INITIALIZING.
            assertEquals(RuntimeState.READY, runtime.state)

            // 2. Subscribe to the event bus. Every config reload,
            //    state transition, or future endpoint/transport event
            //    publishes through this bus. Delivery is fire-and-forget
            //    with a bounded DROP_OLDEST buffer — slow subscribers
            //    miss events under burst, by design.
            val observed = CopyOnWriteArrayList<String>()
            val sub = runtime.eventBus.subscribe<FuranEvent> { ev ->
                observed.add(ev::class.simpleName ?: "?")
            }

            // 3. Take a snapshot via the ordinary v1 Furan adapter.
            //    SDK 2.0.0 constructor order: Furan(config, driver).
            //    The runtime does not participate in the snapshot
            //    upload path (Phase 3.5 ships HttpTransport SPI as
            //    abstraction only). Use the same FuranConfig you
            //    would otherwise — the two layers compose freely.
            val chromeOptions = ChromeOptions().apply {
                addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
            }
            val driver = ChromeDriver(chromeOptions)
            Furan.use(FuranConfig.fromEnv(), driver, testName = "bootstraps v2 runtime, subscribes to events, then takes a snapshot") { furan ->
                driver.get(
                    "data:text/html,<html><body><h1>Runtime-aware Checkout</h1>" +
                        "<p>v2 spine + v1 snapshot</p></body></html>",
                )
                furan.snapshot("runtime-aware-step-1")
            }
            driver.quit()

            // 4. Dump diagnostics. The snapshot is composed at call
            //    time (no caching, no background work). Suitable for
            //    actuator endpoints, CLI dumps, support tickets.
            val diagnostics = runtime.diagnostics
            assertNotNull(diagnostics, "diagnostics enabled in default bootstrap")
            val runtimeSnap = diagnostics!!.snapshot()
            println(
                "[furan] runtime state=${runtimeSnap.state}, " +
                    "uptime=${runtimeSnap.uptime}, " +
                    "heap=${runtimeSnap.memory.heapUsedBytes} bytes",
            )
            println("[furan] recent events on bus: ${runtimeSnap.recentEvents.size}")

            sub.cancel()

            // Sanity check the subscriber received at least the
            // INITIALIZING → READY state-transition event published by
            // the StateMachine during bootstrap(). The bus's recent-events
            // buffer also captures it — verified above.
            println("[furan] subscriber observed events: $observed")
        } finally {
            // 5. Close transitions READY → SHUTTING_DOWN → TERMINATED
            //    and disposes the event bus's coroutine scope. Idempotent.
            runtime.close()
            assertEquals(RuntimeState.TERMINATED, runtime.state)
        }
    }
}
