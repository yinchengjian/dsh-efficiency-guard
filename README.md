# dsh-efficiency-guard

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that removes the dominant source of dead time in long agent sessions: **blind foreground `sleep` polling**.

## Why this exists

An audit of 8 real sessions (511 agent steps, ~3.3 h of agent wall-clock in the longest) found three mechanisms that stretch even simple tasks into 10+ minutes:

1. **72% of wall-clock is tool-wait, not model latency.** The model spends only ~28% of the time generating; the rest is spent waiting on tool calls that run *serially* (measured parallelism ~0.96, effectively one call at a time).
2. **The 120-second tool-call budget forces polling loops.** Long work (data syncs, backtests, docker builds) exceeds the default 120 s call ceiling, so the model invented `sleep 100/110/115` + a grep probe and looped it. 45 such commands consumed **63.5 minutes** in one session, dead time that produced nothing.
3. **`job_output(wait: true)` is capped by the same 120 s ceiling**, so a 5-minute wait returned "Error: wait aborted" after 120 s (7 occurrences) and the model re-polled the same job 17, 13, and 9 times.

This plugin fixes the *behavior*: it teaches the background-first recipe in the system prompt and, because pre-execute cannot rewrite arguments and post-execute only fires after the time is already spent, **denies** a blind foreground wait *before* it burns the budget, pointing at the correct pattern instead.

## What it does

- **System-prompt section** (`efficiency:budget`, order 990, just ahead of the bash tool description) stating the budget facts and the recipe: background long commands, batch independent calls with `Promise.all`, never foreground-sleep.
- **`tools/pre-execute` guard** on the `bash` tool: a command whose foreground `sleep` exceeds `minSleepSeconds` (default 20 s) is denied with corrective feedback. `run_in_background: true` is always allowed, so real work is pushed onto the non-blocking path.

## Install

Install a pinned release by git tag, the same way `dsh-workbuddy-connect` is
installed:

```sh
dsh plugin --profile web add "github:yinchengjian/dsh-efficiency-guard#v0.1.0"
```

then list it in the profile's bundles in `package.json`:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-efficiency-guard"] } }
```

and rebuild/restart the web profile. The plugin ships a `cordis.patch.yml`
that inserts itself, so listing it in `bundles` is all that is required.

Pin a specific tag (`#v0.1.0`) rather than `main` so a breaking change never
lands silently. Release tags are named `v<version>` matching `package.json`.

## Configuration

Tune the row by id `efficiency-guard` in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: efficiency-guard
  config:
    enabled: true        # master switch
    guardSleep: true     # deny blind foreground waits
    minSleepSeconds: 20  # shortest sleep treated as a wasted wait
    toolNames: [bash]    # tools whose args are inspected for a `command`
    allowPatterns: []    # regexes; a matching command is never denied
```

Invalid values (a non-positive threshold, an empty tool list, or a malformed allow pattern) fail at load, never silently.

## Development

```sh
pnpm test   # node --test test/
```

`lib/detect.js` is dependency-free on purpose so the pure logic is testable from a checkout where the `@deepseek-ai/*` packages only resolve inside a booted profile.

## Notes / limits

- Commands containing a heredoc (`<<`) are never inspected, because text written into a script file is not a foreground wait.
- Only `sleep` at a command position (start, or after `;`/`&&`/`||`/`|`/`(`/`then`/`do`/`{`) is matched; quoted literals and `time.sleep(...)` are ignored.
- This plugin addresses *behavior*. The other half of the fix is *budget*: raising the 120 s ceilings is a profile-config change, not a plugin concern.

