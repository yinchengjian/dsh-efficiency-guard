import test from "node:test";
import assert from "node:assert/strict";
import { computeSessionMetrics, formatDuration, isSleepPoll, renderReport } from "../lib/metrics.js";

const ev = (type, time, data = {}) => ({ type, seq: 0, time, data });

test("isSleepPoll detects foreground sleeps only", () => {
  assert.equal(isSleepPoll("bash", "sleep 115; grep x"), true);
  assert.equal(isSleepPoll("bash", "cd /x && sleep 30"), true);
  assert.equal(isSleepPoll("bash", "echo 'sleep 999'"), false, "quoted literal");
  assert.equal(isSleepPoll("bash", "cat <<'EOF'\nsleep 999\nEOF"), false, "heredoc");
  assert.equal(isSleepPoll("read", "sleep 999"), false, "wrong tool");
  assert.equal(isSleepPoll("bash", "grep -r foo ."), false);
});

test("formatDuration renders compactly", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(754_000), "12m 34s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(3_600_000), "1h");
});

test("computeSessionMetrics splits model vs tool vs sleep", () => {
  // one turn, one step:
  //   step/start at 1000, assistant/message at 4000 (model = 3s),
  //   tool/call bash "sleep 5" at 4100, tool/result at 5100 (sleep = 1s),
  //   step/end at 5100 (tool = 1.1s)
  const events = [
    ev("turn/start", 1000, { turn: 1 }),
    ev("step/start", 1000, { turn: 1, step: 1 }),
    ev("assistant/message", 4000, { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } }),
    ev("tool/call", 4100, { turn: 1, step: 1, callId: "c1", name: "bash", arguments: JSON.stringify({ command: "sleep 5; echo hi" }) }),
    ev("tool/result", 5100, { turn: 1, step: 1, message: { role: "tool", toolCallId: "c1", content: [] } }),
    ev("step/end", 5100, { turn: 1, step: 1 }),
    ev("turn/end", 5100, { turn: 1, reason: "stop" }),
  ];
  const m = computeSessionMetrics(events, 3);
  assert.equal(m.steps, 1);
  assert.equal(m.modelMs, 3000);
  assert.equal(m.toolMs, 1100);
  assert.equal(m.sleepCalls, 1);
  assert.equal(m.sleepSeconds, 1);
  assert.equal(m.interceptions, 3);
  assert.equal(m.turnWallMs, 4100);
});

test("computeSessionMetrics handles steps without assistant/message", () => {
  const events = [
    ev("step/start", 1000, { turn: 1, step: 1 }),
    ev("step/end", 2000, { turn: 1, step: 1 }),
  ];
  const m = computeSessionMetrics(events, 0);
  assert.equal(m.modelMs, 1000, "aborted step attributed to model");
  assert.equal(m.toolMs, 0);
});

test("renderReport includes the key figures", () => {
  const m = { wallMs: 100_000, turnWallMs: 100_000, modelMs: 30_000, toolMs: 70_000, sleepSeconds: 20, sleepCalls: 5, interceptions: 4, steps: 3 };
  const text = renderReport(m);
  assert.match(text, /模型生成/);
  assert.match(text, /sleep 空转/);
  assert.match(text, /拦截前台 sleep/);
  assert.match(text, /4 次/);
  assert.doesNotMatch(text, /Token/, "token line removed (DSH already shows it)");
});
