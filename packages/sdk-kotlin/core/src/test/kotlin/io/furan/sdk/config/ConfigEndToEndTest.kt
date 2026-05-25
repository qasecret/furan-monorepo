package io.furan.sdk.config

import io.furan.sdk.config.sources.DefaultsConfigSource
import io.furan.sdk.config.sources.EnvConfigSource
import io.furan.sdk.config.sources.SystemPropertyConfigSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Properties

class ConfigEndToEndTest {

    @Test
    fun `env overrides sysprop overrides defaults`() {
        val env = mapOf(
            "FURAN_API__URL" to "https://from-env",
            "FURAN_API__KEY" to "secret-from-env",
        )
        val sysprops = Properties().apply {
            setProperty("furan.apiUrl", "https://from-sysprop")
            setProperty("furan.retry.maxAttempts", "7")
        }

        val resolver = ConfigurationResolver(listOf(
            DefaultsConfigSource(),
            SystemPropertyConfigSource(propsProvider = { sysprops }),
            EnvConfigSource(lookup = { env[it] }, enumerate = { env.keys }),
        ))
        val registry = resolver.resolve()

        // env wins over sysprop
        assertEquals("https://from-env", registry.get<String>("furan.apiUrl")?.value)
        assertEquals("env", registry.get<String>("furan.apiUrl")?.source)

        // sysprop wins over defaults
        assertEquals("7", registry.get<String>("furan.retry.maxAttempts")?.value)
        assertEquals("sysprop", registry.get<String>("furan.retry.maxAttempts")?.source)

        // defaults flow through when no override
        assertEquals(true, registry.get<Boolean>("furan.transport.gzip")?.value)
        assertEquals("defaults", registry.get<Boolean>("furan.transport.gzip")?.source)
    }

    @Test
    fun `null clear by sysprop wipes inherited yaml value`() {
        val env = emptyMap<String, String>()
        val sysprops = Properties().apply {
            setProperty("furan.transport.proxy", "null")  // literal "null" → null
        }

        val resolver = ConfigurationResolver(listOf(
            // Lower-priority "yaml" source supplied via a synthetic fake.
            object : ConfigSource {
                override val name = "yaml"; override val priority = 60
                override fun load() = mapOf("furan.transport.proxy" to "http://corp:3128")
            },
            SystemPropertyConfigSource(propsProvider = { sysprops }),
            EnvConfigSource(lookup = { env[it] }, enumerate = { env.keys }),
        ))
        val registry = resolver.resolve()

        assertNull(registry.get<String>("furan.transport.proxy")?.value)
        assertEquals("sysprop", registry.get<String>("furan.transport.proxy")?.source)
    }

    @Test
    fun `dump output is operator-friendly and masks secrets`() {
        val env = mapOf(
            "FURAN_API__URL" to "https://from-env",
            "FURAN_API__KEY" to "ZZZ-do-not-print",
        )
        val resolver = ConfigurationResolver(listOf(
            DefaultsConfigSource(),
            EnvConfigSource(lookup = { env[it] }, enumerate = { env.keys }),
        ))
        val out = resolver.resolve().dump(masked = true)
        assertTrue(out.contains("furan.apiUrl"))
        assertTrue(out.contains("https://from-env"))
        assertTrue(out.contains("p=100"))   // env priority appears
        assertTrue(out.contains("p=10"))    // defaults priority appears
        assertTrue(out.contains("******"))
        assertTrue(!out.contains("ZZZ-do-not-print"))
    }
}
