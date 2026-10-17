# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-10-17

### Fixed

- DSH 0.2.1-rc.2 skipped this plugin as incompatible: the `dsh-system-prompt`
  and `dsh-tools` peers were pinned to `0.2.0-rc.2` and dsh matches exact
  peer versions. They now pin `0.2.1-rc.2`, and `cordis` follows the core's
  `^4.0.5`. No code changed: the contracts this plugin uses (`systemPrompt`
  `section`/`getSectionOrder`, the `tools/pre-execute` guard, and
  `commands.register`) are unchanged in 0.2.1-rc.2 apart from additive
  optional fields.

## [0.2.1] - 2026-10-17

### Fixed

- `/efficiency` returned "no session events available for this agent" because it
  round-tripped through the session store using the wrong field. The runtime
  Agent exposes its live session directly as `agent.session`; read its
  `ownEvents()` from there instead.

## [0.2.0] - 2026-10-17

### Added

- `/efficiency` slash command that replays the current session's durable event
  log and reports the model-vs-tool-vs-idle split, the sleep-poll count, and
  how many waits the guard has blocked.
- `lib/metrics.js` dependency-free core: `computeSessionMetrics` (step/turn
  replay, model/tool/sleep attribution, token sums) and `renderReport`.
- Sleep-poll detection now runs over `tool/ptc-dispatch` events, so it works in
  PTC mode where `bash` runs nested inside `run_code`; `tool/call`/`tool/result`
  pairing is kept for native mode.
- Live interception counter keyed by agent (denied calls emit no `tool/result`).

## [0.1.1] - 2026-10-17

### Fixed

- `apply()` crashed with `TypeError: Cannot read properties of undefined
  (reading 'minSleepSeconds')` when the bundle row had no `config:` block,
  because cordis passes `config` as `undefined` in that case. Schema defaults
  are now materialized before the semantic pass.
- `resolveGuardConfig` now rejects a missing config with a clear error instead
  of a `TypeError`.
- Added a regression test that applies the plugin with `undefined` config.

## [0.1.0] - 2026-10-16

### Added

- System-prompt section `efficiency:budget` stating the per-call wall-clock
  budget facts and the background-first recipe.
- `tools/pre-execute` guard that denies blind foreground `sleep` waits above
  `minSleepSeconds` with corrective feedback.
- Dependency-free `lib/detect.js` core (stripQuoted, detectForegroundSleep,
  inspectSleepCall, resolveGuardConfig, buildSleepReason) for standalone testing.
- Unit test suite (`node --test`) plus a boot-time `verify/apply.test.mjs` harness.

## [Unreleased]
