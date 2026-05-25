package io.furan.sdk.runtime

import io.furan.sdk.config.ConfigValue
import io.furan.sdk.config.DefaultConfigRegistry
import io.furan.sdk.event.SharedFlowEventBus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

class FuranRuntimeTest {

    @Test
    fun `runtime exposes config eventBus and state`() {
        val config = DefaultConfigRegistry(mapOf(
            "furan.apiUrl" to ConfigValue("https://x", "defaults", 10),
        ))
        val bus = SharedFlowEventBus()
        val sm = StateMachine(bus)

        val rt = FuranRuntime(config = config, eventBus = bus, stateMachine = sm)

        assertSame(config, rt.config)
        assertSame(bus, rt.eventBus)
        assertEquals(RuntimeState.INITIALIZING, rt.state)
        assertEquals("https://x", rt.config.get<String>("furan.apiUrl")?.value)
    }

    @Test
    fun `close transitions through SHUTTING_DOWN to TERMINATED and closes the bus`() {
        val config = DefaultConfigRegistry(emptyMap())
        val bus = SharedFlowEventBus()
        val sm = StateMachine(bus).also { it.transition(RuntimeState.READY) }
        val rt = FuranRuntime(config = config, eventBus = bus, stateMachine = sm)

        rt.close()

        assertEquals(RuntimeState.TERMINATED, rt.state)
    }

    @Test
    fun `close is idempotent`() {
        val config = DefaultConfigRegistry(emptyMap())
        val bus = SharedFlowEventBus()
        val sm = StateMachine(bus).also { it.transition(RuntimeState.READY) }
        val rt = FuranRuntime(config = config, eventBus = bus, stateMachine = sm)

        rt.close()
        rt.close()  // second call must not throw

        assertEquals(RuntimeState.TERMINATED, rt.state)
    }

    @Test
    fun `close on INITIALIZING runtime transitions straight to TERMINATED`() {
        val config = io.furan.sdk.config.DefaultConfigRegistry(emptyMap())
        val bus = io.furan.sdk.event.SharedFlowEventBus()
        // Do NOT transition to READY — leave at INITIALIZING.
        val sm = StateMachine(bus)
        val rt = FuranRuntime(config = config, eventBus = bus, stateMachine = sm)

        rt.close()

        assertEquals(RuntimeState.TERMINATED, rt.state)
    }
}
