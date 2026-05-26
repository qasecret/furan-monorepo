package io.furan.sdk.runtime

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.diagnostics.RuntimeDiagnostics
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RuntimeWithDiagnosticsTest {

    @Test
    fun `default bootstrap wires diagnostics (always-on)`() {
        val rt = FuranBootstrapper(sources = listOf(DefaultsConfigSource())).bootstrap()
        assertNotNull(rt.diagnostics)
        val snap = rt.diagnostics!!.snapshot()
        assertEquals(RuntimeState.READY, snap.state)
        assertTrue(snap.uptime.inWholeMilliseconds >= 0)
        rt.close()
    }

    @Test
    fun `bootstrap with enableDiagnostics=false leaves diagnostics null`() {
        val rt = FuranBootstrapper(
            sources = listOf(DefaultsConfigSource()),
            enableDiagnostics = false,
        ).bootstrap()
        assertNull(rt.diagnostics)
        rt.close()
    }

    @Test
    fun `runtime constructed directly with a diagnostics field exposes it`() {
        val bus = io.furan.sdk.event.SharedFlowEventBus()
        val sm = StateMachine(bus)
        val fakeDiag = object : RuntimeDiagnostics {
            override fun snapshot(): io.furan.sdk.diagnostics.RuntimeSnapshot =
                io.furan.sdk.diagnostics.RuntimeSnapshot(
                    state = RuntimeState.READY,
                    uptime = kotlin.time.Duration.ZERO,
                    memory = io.furan.sdk.diagnostics.MemoryStats(0, 0, 0),
                )
        }
        val rt = FuranRuntime(
            config = io.furan.sdk.config.DefaultConfigRegistry(emptyMap()),
            eventBus = bus,
            stateMachine = sm,
            diagnostics = fakeDiag,
        )
        assertEquals(fakeDiag, rt.diagnostics)
        rt.close()
    }
}
