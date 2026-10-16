import test from "node:test";
import assert from "node:assert/strict";
import { buildSleepReason, detectForegroundSleep, EFFICIENCY_SECTION, inspectSleepCall, parseSleepSeconds, resolveGuardConfig, stripQuoted } from "../lib/detect.js";

const config = () => resolveGuardConfig({ enabled: true, guardSleep: true, minSleepSeconds: 20, toolNames: ["bash"], allowPatterns: [] });

test("stripQuoted blanks quoted bodies and preserves length", () => {
  const src = "echo 'sleep 100' && echo \"sleep 200\"";
  const out = stripQuoted(src);
  assert.equal(out.length, src.length);
  assert.equal(detectForegroundSleep(src), undefined, "quoted sleeps must not count");
});

test("stripQuoted handles unterminated quotes without throwing", () => {
  assert.equal(stripQuoted("echo 'oops").length, "echo 'oops".length);
  assert.equal(stripQuoted('echo "oops').length, 'echo "oops'.length);
});

test("parseSleepSeconds converts units", () => {
  assert.equal(parseSleepSeconds("5", ""), 5);
  assert.equal(parseSleepSeconds("2", "m"), 120);
  assert.equal(parseSleepSeconds("1", "h"), 3600);
  assert.equal(parseSleepSeconds("0", ""), undefined);
  assert.equal(parseSleepSeconds("abc", ""), undefined);
});

test("detectForegroundSleep finds waits at command positions", () => {
  assert.equal(detectForegroundSleep("sleep 30")?.seconds, 30);
  assert.equal(detectForegroundSleep("true; sleep 45")?.seconds, 45);
  assert.equal(detectForegroundSleep("true && sleep 2m")?.seconds, 120);
  assert.equal(detectForegroundSleep("echo x || sleep 7")?.seconds, 7);
  assert.equal(detectForegroundSleep("if true; then sleep 9; fi")?.seconds, 9);
  assert.equal(detectForegroundSleep("(sleep 11)")?.seconds, 11);
  assert.equal(detectForegroundSleep("cd /tmp && sleep 115; ls")?.seconds, 115);
  assert.equal(detectForegroundSleep("sleep 5\nsleep 40")?.count, 2);
  assert.equal(detectForegroundSleep("sleep 5\nsleep 40")?.seconds, 40);
});

test("detectForegroundSleep ignores non-command positions and heredocs", () => {
  assert.equal(detectForegroundSleep("echo sleeping 100"), undefined);
  assert.equal(detectForegroundSleep("cat <&1"), undefined);
  assert.equal(detectForegroundSleep("python -c 'x' <<'PY'\nsleep 999\nPY"), undefined, "heredoc bodies are not foreground waits");
  assert.equal(detectForegroundSleep("mysleep 100"), undefined);
  assert.equal(detectForegroundSleep(""), undefined);
  assert.equal(detectForegroundSleep(undefined), undefined);
});

test("inspectSleepCall blocks a blind wait and allows run_in_background", () => {
  const cfg = config();
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "sleep 115" } }, cfg)?.seconds, 115);
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "sleep 115", run_in_background: true } }, cfg), undefined);
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "sleep 5" } }, cfg), undefined, "below threshold");
  assert.equal(inspectSleepCall({ name: "read", arguments: { file_path: "x" } }, cfg), undefined);
  assert.equal(inspectSleepCall({ name: "bash", arguments: {} }, cfg), undefined);
});

test("allowPatterns exempts a command", () => {
  const cfg = resolveGuardConfig({ enabled: true, guardSleep: true, minSleepSeconds: 20, toolNames: ["bash"], allowPatterns: ["^make wait-for-db"] });
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "make wait-for-db && sleep 60" } }, cfg), undefined);
  assert.ok(inspectSleepCall({ name: "bash", arguments: { command: "sleep 60" } }, cfg));
});

test("resolveGuardConfig fails loud on bad input", () => {
  const base = { enabled: true, guardSleep: true, minSleepSeconds: 20, toolNames: ["bash"], allowPatterns: [] };
  assert.throws(() => resolveGuardConfig({ ...base, minSleepSeconds: 0 }), /minSleepSeconds/);
  assert.throws(() => resolveGuardConfig({ ...base, toolNames: [] }), /toolNames/);
  assert.throws(() => resolveGuardConfig({ ...base, allowPatterns: ["("] }), /allowPatterns/);
});

test("guardSleep/enabled false disables the check", () => {
  const off = resolveGuardConfig({ enabled: false, guardSleep: true, minSleepSeconds: 20, toolNames: ["bash"], allowPatterns: [] });
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "sleep 115" } }, off), undefined);
  const noSleep = resolveGuardConfig({ enabled: true, guardSleep: false, minSleepSeconds: 20, toolNames: ["bash"], allowPatterns: [] });
  assert.equal(inspectSleepCall({ name: "bash", arguments: { command: "sleep 115" } }, noSleep), undefined);
});

test("buildSleepReason names the cost and the alternative", () => {
  const reason = buildSleepReason({ seconds: 115, count: 1 }, 20);
  assert.match(reason, /115s/);
  assert.match(reason, /run_in_background: true/);
  assert.match(reason, /job_output/);
  const plural = buildSleepReason({ seconds: 40, count: 2 }, 20);
  assert.match(plural, /2 blind sleeps/);
});

test("EFFICIENCY_SECTION states the budget facts", () => {
  assert.match(EFFICIENCY_SECTION, /120s/);
  assert.match(EFFICIENCY_SECTION, /run_in_background: true/);
});
