# Migrating from Applitools Eyes to Furan

Furan ships **Loupe** — an Applitools Eyes-compatible facade (Eyes Compatibility Level v1, targeting Applitools Eyes SDK 5.x). If you already have tests written against the Applitools Java/Kotlin SDK, you can swap imports and migrate with minimal changes. The facade wraps Furan's native `FuranCapture` engine so you get Furan's capture, diff, and review pipeline behind an API surface that mirrors Applitools' `Eyes.open / check / close`.

## Side-by-side comparison

**Applitools Eyes (Java):**

```java
WebDriver driver = new ChromeDriver();
Eyes eyes = new Eyes();
eyes.setApiKey(System.getenv("APPLITOOLS_API_KEY"));
eyes.open(driver, "App", "Test");
eyes.checkWindow("Home");
eyes.close();
```

**Furan (Kotlin) — via the `Loupe` facade:**

```kotlin
val driver = ChromeDriver()
val loupe = Loupe(FuranConfig.fromEnv(), driver)
loupe.open("App", "Test")
driver.get("https://example.com/")
loupe.check("Home")
loupe.close()
```

The key structural differences:

- `FuranConfig.fromEnv()` replaces the API key setter; see [Config](#config) below.
- The driver is injected into `Loupe(config, driver)` rather than passed to `open`.
- `checkWindow` → `check(name)` (per-name checkpoint model, see below).
- No `setServerURL` / `setBatch` — Furan uses project-level batching automatically.

## Status mapping

When a run completes, Furan's `run_status` maps to Applitools Eyes concepts as follows:

| Furan `run_status` | Eyes status | Passing                                            | When                                                                       |
| ------------------ | ----------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `passed`           | Passed      | yes                                                | All checkpoints match the accepted baseline                                |
| `new`              | New         | configurable via `saveNewTests` (Eyes default: on) | No baseline yet for this checkpoint                                        |
| `unresolved`       | Unresolved  | no                                                 | Pixel diff detected vs baseline, awaiting human review                     |
| `failed`           | Failed      | no                                                 | A previously-unresolved diff was rejected / marked as bug in the dashboard |
| `aborted`          | Aborted     | no                                                 | `abort()` was called before `close()`                                      |
| `empty`            | Empty       | yes (pass + WARN log)                              | `close()` called but zero `check()` calls were made                        |

## Behavior differences

### First-baseline handling

Furan's native API defaults to **manual first baseline**: the first run for a new test is `new` and sits in the dashboard awaiting human approval before it becomes the accepted baseline. This is a deliberate divergence from Applitools, which auto-seeds the baseline on the first run.

The Loupe facade restores Applitools behavior: `saveNewTests` defaults to `true`, so the first `close()` auto-accepts the new screenshots as the baseline without manual approval. If you want the Furan-native behavior (manual approval gate on first run), construct the facade with `saveNewTests = false`:

```kotlin
val loupe = Loupe(FuranConfig.fromEnv(), driver, saveNewTests = false)
```

### Per-name checkpoint model

Each `check(name)` call is its own independent comparison keyed by name. Unlike Applitools' window-level and region-level checks (`checkWindow`, `checkRegion`), Furan always captures a full-page screenshot and associates it with the checkpoint name you supply. Provide distinct names within a test to get distinct comparison entries in the dashboard.

### Native Furan features

Advanced features — VLM semantic diff descriptions, ignore/strict/floating regions, accessibility (axe-core) regions, layout match level, element-map-based suppression — are only available through the native `Furan` API (`io.furan.sdk.selenium.Furan`). The `Loupe` facade is compatibility-conservative and will not surface these. If you want Furan-specific capabilities, migrate fully to the native API.

## Fail-on-diff knob

By default Furan does not fail a test immediately when a visual diff is detected. Diffs are queued for human review in the dashboard. You can change this behavior with the `FURAN_FAIL_ON_DIFF` environment variable (or `local.properties` key):

| Value       | Behavior                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| `None`      | Default. `close()` returns results; test does not throw on diff.                         |
| `AfterEach` | `close()` throws if the run has any unresolved/failed diff. Each test fails immediately. |
| `AfterAll`  | The JUnit 5 extension accumulates diffs and throws once at the end of the suite.         |

Example — fail immediately on diff:

```bash
FURAN_FAIL_ON_DIFF=AfterEach ./gradlew test
```

Or in `local.properties`:

```
FURAN_FAIL_ON_DIFF=AfterEach
```

## Config

All configuration is driven by environment variables (or `local.properties` in the example module). `FuranConfig.fromEnv()` reads these automatically:

| Variable               | Required | Description                                                       |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `FURAN_API_URL`        | yes      | Base URL of your Furan API, e.g. `https://furan.example.com`      |
| `FURAN_API_TOKEN`      | yes      | A personal access token (`furan_pat_*`), minted in the dashboard  |
| `FURAN_PROJECT_ID`     | yes      | UUID of the project to post runs to                               |
| `FURAN_SAVE_NEW_TESTS` | no       | `true` / `false` — overrides the `saveNewTests` constructor param |
| `FURAN_BRANCH`         | no       | Branch name to associate with the run (default: `main`)           |
| `FURAN_DASHBOARD_URL`  | no       | Public URL of the dashboard (used in result links in CI logs)     |

To mint a PAT, go to **Dashboard → Account → Tokens → New token**. The token is shown once; copy it to `FURAN_API_TOKEN`.
