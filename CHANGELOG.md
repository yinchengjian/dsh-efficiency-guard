# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
