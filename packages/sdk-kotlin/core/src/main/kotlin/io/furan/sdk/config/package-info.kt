/**
 * Layered, provenance-tracking configuration subsystem for the Furan
 * Kotlin SDK.
 *
 * ## Entry points
 *
 *  - [ConfigSource] — the abstraction every source implements.
 *  - [ConfigurationResolver] — overlays sources into a [ConfigRegistry].
 *  - [ConfigRegistry] — provenance-aware view, queried via `get(key)`.
 *
 * ## Built-in sources (in priority order, highest first)
 *
 *  - [io.furan.sdk.config.sources.EnvConfigSource]
 *      (priority [ConfigPriority.ENV])
 *      reads `FURAN_*` environment variables; uses Spring relaxed
 *      binding (`__` = camelCase boundary, `_` = path separator).
 *  - [io.furan.sdk.config.sources.SystemPropertyConfigSource]
 *      (priority [ConfigPriority.SYSPROP])
 *      reads `-Dfuran.*` JVM properties verbatim; the literal string
 *      `"null"` is decoded to `null` for explicit clears.
 *  - [io.furan.sdk.config.sources.YamlConfigSource]
 *      (priority [ConfigPriority.YAML])
 *      reads `application.yml` (or any YAML file / classpath resource);
 *      flattens nested maps to dotted keys rooted at `furan.`. Lists
 *      are kept as-is; scalar `null` / string `"null"` clear inherited
 *      values per the null-clears merge rule.
 *  - [io.furan.sdk.config.sources.DefaultsConfigSource]
 *      (priority [ConfigPriority.DEFAULTS])
 *      SDK-shipped fallback values.
 *
 * ## Merge semantics
 *
 * See [ConfigMerge]:
 *  - higher-priority scalar replaces lower;
 *  - higher-priority `null` CLEARS lower (Kubernetes-style);
 *  - nested maps REPLACE wholesale by default — opt in to deep merge
 *    by setting `inherit: true` in the higher-priority map;
 *  - lists REPLACE, never concatenate.
 *
 * ## Provenance
 *
 * Every resolved value carries [ConfigValue.source] +
 * [ConfigValue.priority] so operators can answer "why is this value
 * what it is?" via [ConfigRegistry.dump]. Secret values are masked
 * by [DefaultSecretMasker].
 *
 * ## What's NOT in this phase
 *
 *  - Spring Environment integration (Phase 4 of the v2 spec).
 *  - Hot reload + EventBus publishing (Phase 2 of the v2 spec).
 *  - Binding into a typed `FuranConfig` (kept in the existing
 *    `FuranConfig.fromEnv()` / `FuranConfig.fromYaml()` paths;
 *    deep v2 integration deferred to a non-breaking follow-up).
 */
package io.furan.sdk.config
