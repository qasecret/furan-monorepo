# Changelog

## [3.1.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v3.0.0...sdk/v3.1.0) (2026-05-30)


### Features

* **sdk-kotlin:** ignoreCaret selector-mask (Eyes parity Tier 2.4) ([#214](https://github.com/qasecret/furan-monorepo/issues/214)) ([dad8795](https://github.com/qasecret/furan-monorepo/commit/dad8795f5ac440645005740f6b9599a0ca00ebde))
* **sdk-kotlin:** matchTimeoutMs stability poll (Eyes parity Tier 2.3) ([#213](https://github.com/qasecret/furan-monorepo/issues/213)) ([ee18649](https://github.com/qasecret/furan-monorepo/commit/ee186492a0c1166972187b3bd3172f88d9ae9876))
* **sdk-kotlin:** sendDom opt-out (Eyes parity Tier 2.2) ([#212](https://github.com/qasecret/furan-monorepo/issues/212)) ([80adc4b](https://github.com/qasecret/furan-monorepo/commit/80adc4b40156a1399972235ec7c475b989219b06))
* **sdk,db,api,diff-engine,diff-worker:** accessibility validation (Tier 2.5) ([#215](https://github.com/qasecret/furan-monorepo/issues/215)) ([efad14b](https://github.com/qasecret/furan-monorepo/commit/efad14b76776a149b7d52c418aa073d058f5e48d))

## [3.0.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v2.2.0...sdk/v3.0.0) (2026-05-30)

### ⚠ BREAKING CHANGES

- snapshot() before open() now throws IllegalStateException; return types changed from RunResult to CheckpointSubmission/CheckpointResult; Furan constructor signature changed to (config, driver) order. SDK 2.0.0 via release-please when this lands.
- **api,sdk-kotlin:** gate first-baseline auto-seed on project.autoApproveFeature (ADR-036) ([#181](https://github.com/qasecret/furan-monorepo/issues/181))

### Features

- **api,sdk-kotlin:** gate first-baseline auto-seed on project.autoApproveFeature (ADR-036) ([#181](https://github.com/qasecret/furan-monorepo/issues/181)) ([ef9b6ea](https://github.com/qasecret/furan-monorepo/commit/ef9b6ea77b18ffa679252ef1924307b7e2ea139c))
- batch/test/checkpoint model (ADR-038) ([#189](https://github.com/qasecret/furan-monorepo/issues/189)) ([0f8cba1](https://github.com/qasecret/furan-monorepo/commit/0f8cba1c442a0fb4c344a66c1c9390bbca775ff1))
- builds-as-batches stage 2 — Kotlin SDK ([#51](https://github.com/qasecret/furan-monorepo/issues/51)) ([c5a6bfd](https://github.com/qasecret/furan-monorepo/commit/c5a6bfd752ba6dd94f3da0269de862a187913b12))
- **sdk-example:** local.properties for one-liner local dev runs ([#157](https://github.com/qasecret/furan-monorepo/issues/157)) ([05d7513](https://github.com/qasecret/furan-monorepo/commit/05d7513f8c003c4d0919d9be612dd89b22bc0778))
- **sdk-kotlin:** application.yml/yaml config source + FuranConfig.fromYaml() bridge ([#158](https://github.com/qasecret/furan-monorepo/issues/158)) ([ab68fb0](https://github.com/qasecret/furan-monorepo/commit/ab68fb09c9a701957a279ee7f0e1451041ba15b0))
- **sdk-kotlin:** auto-discover classpath application.yml + FuranConfig.fromClasspath() ([#178](https://github.com/qasecret/furan-monorepo/issues/178)) ([b15b745](https://github.com/qasecret/furan-monorepo/commit/b15b745f4737469ab4620bcce65c7b1baf82fa77))
- **sdk-kotlin:** Bootstrap + Runtime spine (Phase 2 of SDK v2 spec) ([#138](https://github.com/qasecret/furan-monorepo/issues/138)) ([a85dd1f](https://github.com/qasecret/furan-monorepo/commit/a85dd1fd29967f72b51c0b836aad21e6ed28a49b))
- **sdk-kotlin:** CSS-selector-anchored regions (Eyes parity Tier 1.2) ([#205](https://github.com/qasecret/furan-monorepo/issues/205)) ([a517453](https://github.com/qasecret/furan-monorepo/commit/a517453f280f64ecc7678dc050c0f3990d548600))
- **sdk-kotlin:** EndpointResolver chain (Phase 3 of SDK v2 spec) ([#139](https://github.com/qasecret/furan-monorepo/issues/139)) ([ade0f7b](https://github.com/qasecret/furan-monorepo/commit/ade0f7b14f9cb9eb2e74d60cd1f3368615970b44))
- **sdk-kotlin:** example tests for ignore regions + v2 runtime spine ([#149](https://github.com/qasecret/furan-monorepo/issues/149)) ([d99d9bd](https://github.com/qasecret/furan-monorepo/commit/d99d9bd8c62d2de7b81157d35ae85d69ca4c7f67))
- **sdk-kotlin:** furan-junit5 module with @FuranTest extension ([#133](https://github.com/qasecret/furan-monorepo/issues/133)) ([c18dd8e](https://github.com/qasecret/furan-monorepo/commit/c18dd8ed1aea3d3a13f29b7cf73595c4c4322b30))
- **sdk-kotlin:** FuranException hierarchy expansion + transport wrapping ([#132](https://github.com/qasecret/furan-monorepo/issues/132)) ([e624e15](https://github.com/qasecret/furan-monorepo/commit/e624e1538399296806056a5b6f8e5ba45900285f))
- **sdk-kotlin:** HttpTransport SPI (Phase 3.5 of SDK v2 spec — abstraction layer only) ([#145](https://github.com/qasecret/furan-monorepo/issues/145)) ([80bd3e3](https://github.com/qasecret/furan-monorepo/commit/80bd3e3198ee393c97f568e4f44acba1bdaf194a))
- **sdk-kotlin:** layered ConfigSource subsystem (Phase 1 of SDK v2 spec) ([#136](https://github.com/qasecret/furan-monorepo/issues/136)) ([980cded](https://github.com/qasecret/furan-monorepo/commit/980cded40e40c6595a92ce599006ed26c4d0a11e))
- **sdk-kotlin:** lazy-load scroll-and-wait loop (Eyes parity Tier 2.1) ([#210](https://github.com/qasecret/furan-monorepo/issues/210)) ([88f7e88](https://github.com/qasecret/furan-monorepo/commit/88f7e88f2158a82fe8276227bda3adda0db1fede))
- **sdk-kotlin:** per-checkpoint region crop (Eyes parity Tier 1.1) ([#203](https://github.com/qasecret/furan-monorepo/issues/203)) ([4e69cb7](https://github.com/qasecret/furan-monorepo/commit/4e69cb7592ae6465d607406cc128f49829c1e18d))
- **sdk-kotlin:** Plugin + Capability Registry (Phase 4 of SDK v2 spec) ([#140](https://github.com/qasecret/furan-monorepo/issues/140)) ([ac768a5](https://github.com/qasecret/furan-monorepo/commit/ac768a52d0605be7b8fd4755288ef1286be2cc77))
- **sdk-kotlin:** pre-capture JS hook + wait (Eyes parity Tier 1.3) ([#206](https://github.com/qasecret/furan-monorepo/issues/206)) ([136db35](https://github.com/qasecret/furan-monorepo/commit/136db35448ea4c064b0ddbb6c57ced1c6fbb1041))
- **sdk-kotlin:** release-please auto-bump + auto-publish to Maven Central ([#13](https://github.com/qasecret/furan-monorepo/issues/13)) ([e6cbbf1](https://github.com/qasecret/furan-monorepo/commit/e6cbbf17080f89f1b0e17d0e9a6f593ea72790f3))
- **sdk-kotlin:** RuntimeDiagnostics snapshot (Phase 6 of SDK v2 spec) ([#142](https://github.com/qasecret/furan-monorepo/issues/142)) ([fea1d2d](https://github.com/qasecret/furan-monorepo/commit/fea1d2d184fa609bf05afd58692ec57835bf92d2))
- **sdk-kotlin:** SuiteResult + Furan.aggregateResults (Eyes parity Tier 1.5) ([#209](https://github.com/qasecret/furan-monorepo/issues/209)) ([e83f368](https://github.com/qasecret/furan-monorepo/commit/e83f368667d1e33bb30ab356b3206187f07810e7))
- **sdk-kotlin:** switch to vanniktech publish plugin + rename to io.github.qasecret:furan-{core,selenium} ([#11](https://github.com/qasecret/furan-monorepo/issues/11)) ([0481d55](https://github.com/qasecret/furan-monorepo/commit/0481d552192ad136af7ca688807eda411f045765))
- **sdk-kotlin:** typed RunStatus, SnapshotResult, snapshotAndAwait ([#128](https://github.com/qasecret/furan-monorepo/issues/128)) ([c140249](https://github.com/qasecret/furan-monorepo/commit/c1402499fcbcdd77625ae10261f3f941d4c94f52))
- **sdk-kotlin:** Weighted/Canary/TenantAffinity resolvers (Phase 7 partial of SDK v2 spec) ([#144](https://github.com/qasecret/furan-monorepo/issues/144)) ([3b2326c](https://github.com/qasecret/furan-monorepo/commit/3b2326c818885343510d131b580194fb6e34f9f9))
- **sdk,api:** per-run diffTolerance + typed ignoreAreas on POST /runs ([#131](https://github.com/qasecret/furan-monorepo/issues/131)) ([cde0d37](https://github.com/qasecret/furan-monorepo/commit/cde0d37558429f5990c4af2802f48b1fcdfcea2b))
- **sdk,db,api,diff-engine,diff-worker:** ignoreDisplacements (Tier 1.4) ([#207](https://github.com/qasecret/furan-monorepo/issues/207)) ([bbb20ea](https://github.com/qasecret/furan-monorepo/commit/bbb20eabfec3ca27abd7f4f98aedb894ce6d670e))
- **sdk:** capture per-element bbox map at snapshot time ([#61](https://github.com/qasecret/furan-monorepo/issues/61)) ([32094d0](https://github.com/qasecret/furan-monorepo/commit/32094d0b69b57ae65a5ac1e5b538593d6e017637))

### Bug Fixes

- **api,sdk-kotlin,dashboard:** per-name visual checkpoints + ignore-region UX (ADR-037) ([#183](https://github.com/qasecret/furan-monorepo/issues/183)) ([413ddc2](https://github.com/qasecret/furan-monorepo/commit/413ddc2e3f8053b4415927ceadb3aa782f730f32))
- **dashboard:** parallel diff-viewer mounts + AbortSignal cancellation ([#82](https://github.com/qasecret/furan-monorepo/issues/82)) ([2ec53d0](https://github.com/qasecret/furan-monorepo/commit/2ec53d0bb3c28317197c8ce16234a32b4b916ac9))
- **sdk-kotlin:** drop null defaults from request bodies so api zod .optional() accepts them ([#30](https://github.com/qasecret/furan-monorepo/issues/30)) ([78eb8c9](https://github.com/qasecret/furan-monorepo/commit/78eb8c98a4743d1e1ccced89b341d6997c06a93e))

## [2.2.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v2.1.0...sdk/v2.2.0) (2026-05-30)

### Features

- **sdk-kotlin:** SuiteResult + Furan.aggregateResults (Eyes parity Tier 1.5) ([#209](https://github.com/qasecret/furan-monorepo/issues/209)) ([e83f368](https://github.com/qasecret/furan-monorepo/commit/e83f368667d1e33bb30ab356b3206187f07810e7))

## [2.1.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v2.0.0...sdk/v2.1.0) (2026-05-30)

### Features

- **sdk-kotlin:** CSS-selector-anchored regions (Eyes parity Tier 1.2) ([#205](https://github.com/qasecret/furan-monorepo/issues/205)) ([a517453](https://github.com/qasecret/furan-monorepo/commit/a517453f280f64ecc7678dc050c0f3990d548600))
- **sdk-kotlin:** per-checkpoint region crop (Eyes parity Tier 1.1) ([#203](https://github.com/qasecret/furan-monorepo/issues/203)) ([4e69cb7](https://github.com/qasecret/furan-monorepo/commit/4e69cb7592ae6465d607406cc128f49829c1e18d))
- **sdk-kotlin:** pre-capture JS hook + wait (Eyes parity Tier 1.3) ([#206](https://github.com/qasecret/furan-monorepo/issues/206)) ([136db35](https://github.com/qasecret/furan-monorepo/commit/136db35448ea4c064b0ddbb6c57ced1c6fbb1041))

## [2.0.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v1.0.1...sdk/v2.0.0) (2026-05-29)

### ⚠ BREAKING CHANGES

- snapshot() before open() now throws IllegalStateException; return types changed from RunResult to CheckpointSubmission/CheckpointResult; Furan constructor signature changed to (config, driver) order. SDK 2.0.0 via release-please when this lands.

### Features

- batch/test/checkpoint model (ADR-038) ([#189](https://github.com/qasecret/furan-monorepo/issues/189)) ([0f8cba1](https://github.com/qasecret/furan-monorepo/commit/0f8cba1c442a0fb4c344a66c1c9390bbca775ff1))

## [1.0.1](https://github.com/qasecret/furan-monorepo/compare/sdk/v1.0.0...sdk/v1.0.1) (2026-05-28)

### Bug Fixes

- **api,sdk-kotlin,dashboard:** per-name visual checkpoints + ignore-region UX (ADR-037) ([#183](https://github.com/qasecret/furan-monorepo/issues/183)) ([413ddc2](https://github.com/qasecret/furan-monorepo/commit/413ddc2e3f8053b4415927ceadb3aa782f730f32))

## [1.0.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.15.0...sdk/v1.0.0) (2026-05-28)

### ⚠ BREAKING CHANGES

- **api,sdk-kotlin:** gate first-baseline auto-seed on project.autoApproveFeature (ADR-036) ([#181](https://github.com/qasecret/furan-monorepo/issues/181))

### Features

- **api,sdk-kotlin:** gate first-baseline auto-seed on project.autoApproveFeature (ADR-036) ([#181](https://github.com/qasecret/furan-monorepo/issues/181)) ([ef9b6ea](https://github.com/qasecret/furan-monorepo/commit/ef9b6ea77b18ffa679252ef1924307b7e2ea139c))

## [0.15.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.14.0...sdk/v0.15.0) (2026-05-28)

### Features

- **sdk-kotlin:** auto-discover classpath application.yml + FuranConfig.fromClasspath() ([#178](https://github.com/qasecret/furan-monorepo/issues/178)) ([b15b745](https://github.com/qasecret/furan-monorepo/commit/b15b745f4737469ab4620bcce65c7b1baf82fa77))

## [0.14.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.13.0...sdk/v0.14.0) (2026-05-28)

### Features

- **sdk-example:** local.properties for one-liner local dev runs ([#157](https://github.com/qasecret/furan-monorepo/issues/157)) ([05d7513](https://github.com/qasecret/furan-monorepo/commit/05d7513f8c003c4d0919d9be612dd89b22bc0778))
- **sdk-kotlin:** application.yml/yaml config source + FuranConfig.fromYaml() bridge ([#158](https://github.com/qasecret/furan-monorepo/issues/158)) ([ab68fb0](https://github.com/qasecret/furan-monorepo/commit/ab68fb09c9a701957a279ee7f0e1451041ba15b0))

## [0.13.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.12.0...sdk/v0.13.0) (2026-05-27)

### Features

- **sdk-kotlin:** example tests for ignore regions + v2 runtime spine ([#149](https://github.com/qasecret/furan-monorepo/issues/149)) ([d99d9bd](https://github.com/qasecret/furan-monorepo/commit/d99d9bd8c62d2de7b81157d35ae85d69ca4c7f67))

## [0.12.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.11.0...sdk/v0.12.0) (2026-05-26)

### Features

- **sdk-kotlin:** HttpTransport SPI (Phase 3.5 of SDK v2 spec — abstraction layer only) ([#145](https://github.com/qasecret/furan-monorepo/issues/145)) ([80bd3e3](https://github.com/qasecret/furan-monorepo/commit/80bd3e3198ee393c97f568e4f44acba1bdaf194a))

## [0.11.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.10.0...sdk/v0.11.0) (2026-05-26)

### Features

- **sdk-kotlin:** RuntimeDiagnostics snapshot (Phase 6 of SDK v2 spec) ([#142](https://github.com/qasecret/furan-monorepo/issues/142)) ([fea1d2d](https://github.com/qasecret/furan-monorepo/commit/fea1d2d184fa609bf05afd58692ec57835bf92d2))
- **sdk-kotlin:** Weighted/Canary/TenantAffinity resolvers (Phase 7 partial of SDK v2 spec) ([#144](https://github.com/qasecret/furan-monorepo/issues/144)) ([3b2326c](https://github.com/qasecret/furan-monorepo/commit/3b2326c818885343510d131b580194fb6e34f9f9))

## [0.10.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.9.0...sdk/v0.10.0) (2026-05-26)

### Features

- **sdk-kotlin:** Bootstrap + Runtime spine (Phase 2 of SDK v2 spec) ([#138](https://github.com/qasecret/furan-monorepo/issues/138)) ([a85dd1f](https://github.com/qasecret/furan-monorepo/commit/a85dd1fd29967f72b51c0b836aad21e6ed28a49b))
- **sdk-kotlin:** EndpointResolver chain (Phase 3 of SDK v2 spec) ([#139](https://github.com/qasecret/furan-monorepo/issues/139)) ([ade0f7b](https://github.com/qasecret/furan-monorepo/commit/ade0f7b14f9cb9eb2e74d60cd1f3368615970b44))
- **sdk-kotlin:** layered ConfigSource subsystem (Phase 1 of SDK v2 spec) ([#136](https://github.com/qasecret/furan-monorepo/issues/136)) ([980cded](https://github.com/qasecret/furan-monorepo/commit/980cded40e40c6595a92ce599006ed26c4d0a11e))
- **sdk-kotlin:** Plugin + Capability Registry (Phase 4 of SDK v2 spec) ([#140](https://github.com/qasecret/furan-monorepo/issues/140)) ([ac768a5](https://github.com/qasecret/furan-monorepo/commit/ac768a52d0605be7b8fd4755288ef1286be2cc77))

## [0.9.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.8.1...sdk/v0.9.0) (2026-05-25)

### Features

- **sdk-kotlin:** furan-junit5 module with @FuranTest extension ([#133](https://github.com/qasecret/furan-monorepo/issues/133)) ([c18dd8e](https://github.com/qasecret/furan-monorepo/commit/c18dd8ed1aea3d3a13f29b7cf73595c4c4322b30))
- **sdk-kotlin:** FuranException hierarchy expansion + transport wrapping ([#132](https://github.com/qasecret/furan-monorepo/issues/132)) ([e624e15](https://github.com/qasecret/furan-monorepo/commit/e624e1538399296806056a5b6f8e5ba45900285f))
- **sdk-kotlin:** typed RunStatus, SnapshotResult, snapshotAndAwait ([#128](https://github.com/qasecret/furan-monorepo/issues/128)) ([c140249](https://github.com/qasecret/furan-monorepo/commit/c1402499fcbcdd77625ae10261f3f941d4c94f52))
- **sdk,api:** per-run diffTolerance + typed ignoreAreas on POST /runs ([#131](https://github.com/qasecret/furan-monorepo/issues/131)) ([cde0d37](https://github.com/qasecret/furan-monorepo/commit/cde0d37558429f5990c4af2802f48b1fcdfcea2b))

## [0.8.1](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.8.0...sdk/v0.8.1) (2026-05-23)

### Bug Fixes

- **dashboard:** parallel diff-viewer mounts + AbortSignal cancellation ([#82](https://github.com/qasecret/furan-monorepo/issues/82)) ([2ec53d0](https://github.com/qasecret/furan-monorepo/commit/2ec53d0bb3c28317197c8ce16234a32b4b916ac9))

## [0.8.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.7.0...sdk/v0.8.0) (2026-05-21)

### Features

- **sdk:** capture per-element bbox map at snapshot time ([#61](https://github.com/qasecret/furan-monorepo/issues/61)) ([32094d0](https://github.com/qasecret/furan-monorepo/commit/32094d0b69b57ae65a5ac1e5b538593d6e017637))

## [0.7.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.6.1...sdk/v0.7.0) (2026-05-19)

### Features

- builds-as-batches stage 2 — Kotlin SDK ([#51](https://github.com/qasecret/furan-monorepo/issues/51)) ([c5a6bfd](https://github.com/qasecret/furan-monorepo/commit/c5a6bfd752ba6dd94f3da0269de862a187913b12))

## [0.6.1](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.6.0...sdk/v0.6.1) (2026-05-17)

### Bug Fixes

- **sdk-kotlin:** drop null defaults from request bodies so api zod .optional() accepts them ([#30](https://github.com/qasecret/furan-monorepo/issues/30)) ([78eb8c9](https://github.com/qasecret/furan-monorepo/commit/78eb8c98a4743d1e1ccced89b341d6997c06a93e))

## [0.6.0](https://github.com/qasecret/furan-monorepo/compare/sdk/v0.5.0...sdk/v0.6.0) (2026-05-17)

### Features

- **sdk-kotlin:** release-please auto-bump + auto-publish to Maven Central ([#13](https://github.com/qasecret/furan-monorepo/issues/13)) ([e6cbbf1](https://github.com/qasecret/furan-monorepo/commit/e6cbbf17080f89f1b0e17d0e9a6f593ea72790f3))
