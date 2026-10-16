/**
 * Pure session-efficiency metrics from a SessionEvent log.
 *
 * Zero imports on purpose (mirrors detect.js) so it is unit-testable from a
 * plain checkout. Replays the same event types dsh writes to the durable
 * session log and computes where the wall-clock went.
 *
 * @module dsh-efficiency-guard/metrics
 */

/**
 * Compute one session's efficiency breakdown from its events.
 *
 * Events are replayed in log order. A step is one model call plus the tool
 * calls it dispatched, so:
 *   - model time  = step/start -> assistant/message (the model generating)
 *   - tool time   = assistant/message -> step/end (the requested tools running)
 * A step without an assistant/message (aborted before any visible content) is
 * attributed entirely to model time as a conservative fallback.
 *
 * @param events - session events, each { type, seq, time, data }.
 * @param interceptions - live counter of sleeps the guard denied this session
 *   (denied calls emit no tool/result, so the log cannot see them).
 * @returns the aggregate metrics.
 */
export function computeSessionMetrics(events, interceptions) {
  const steps = new Map();   // "turn:step" -> { start, asst, end }
  const turns = new Map();   // turn -> { start, end }
  const calls = new Map();   // callId -> { name, command, start } (native tool/call -> tool/result)
  const ptc = new Map();     // subCallId -> { name, command, start } (PTC dispatch-start -> dispatch)
  let sleepCalls = 0;
  let sleepSeconds = 0;
  let stepCount = 0;

  const key = (t, s) => t + ":" + s;

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const type = event.type;
    const time = event.time;
    const data = event.data ?? {};

    if (type === "step/start") {
      steps.set(key(data.turn, data.step), { start: time });
    } else if (type === "step/end") {
      const s = steps.get(key(data.turn, data.step));
      if (s) { s.end = time; stepCount += 1; }
    } else if (type === "assistant/message") {
      const s = steps.get(key(data.turn, data.step));
      if (s) { s.asst = time; }
    } else if (type === "turn/start") {
      turns.set(data.turn, { start: time });
    } else if (type === "turn/end") {
      const t = turns.get(data.turn);
      if (t) t.end = time;
    } else if (type === "tool/call") {
      calls.set(data.callId, { name: data.name, start: time, command: commandOf(data) });
    } else if (type === "tool/result") {
      const callId = data.message?.toolCallId ?? data.callId;
      const c = calls.get(callId);
      if (c) {
        if (isSleepPoll(c.name, c.command)) {
          sleepCalls += 1;
          sleepSeconds += Math.max(0, time - c.start) / 1000;
        }
        calls.delete(callId);
      }
    } else if (type === "tool/ptc-dispatch-start") {
      ptc.set(data.subCallId, { name: data.name, start: time, command: commandOf(data) });
    } else if (type === "tool/ptc-dispatch") {
      const c = ptc.get(data.subCallId);
      if (c) {
        if (isSleepPoll(c.name, c.command)) {
          sleepCalls += 1;
          sleepSeconds += Math.max(0, time - c.start) / 1000;
        }
        ptc.delete(data.subCallId);
      }
    }
  }

  let modelMs = 0;
  let toolMs = 0;
  let wallMs = 0;
  for (const s of steps.values()) {
    if (s.start === undefined) continue;
    const end = s.end ?? s.asst ?? s.start;
    if (s.asst !== undefined) {
      modelMs += s.asst - s.start;
      toolMs += end - s.asst;
    } else {
      modelMs += end - s.start;
    }
    wallMs += end - s.start;
  }
  // Real wall-clock of the session (turn boundaries), which includes any idle
  // time between turns. Step-summed wallMs excludes that gap and is used for
  // the model/tool split; turnWallMs is reported separately as the session clock.
  const turnWallMs = [...turns.values()].reduce((acc, t) => {
    if (t.start !== undefined && t.end !== undefined) return acc + (t.end - t.start);
    return acc;
  }, 0);

  return {
    steps: stepCount,
    wallMs,
    turnWallMs,
    modelMs,
    toolMs,
    sleepCalls,
    sleepSeconds,
    interceptions,
  };
}

/** Extract a bash command string from a tool/call data object, if any. */
function commandOf(data) {
  if (data.name !== "bash") return "";
  const raw = data.arguments;
  // tool/call logs arguments as a JSON string; tool/ptc-dispatch logs the
  // parsed object. Accept both.
  if (typeof raw === "string") {
    try {
      const args = JSON.parse(raw);
      return typeof args.command === "string" ? args.command : "";
    } catch {
      return "";
    }
  }
  if (raw !== null && typeof raw === "object" && typeof raw.command === "string") {
    return raw.command;
  }
  return "";
}

/**
 * A foreground sleep poll: a bash command whose first statement is a sleep.
 * Mirrors detect.js's detector but works from the logged command string, so the
 * two stay consistent. Heredocs and quoted literals are skipped.
 */
export function isSleepPoll(name, command) {
  if (name !== "bash") return false;
  if (typeof command !== "string" || command.length === 0) return false;
  if (command.includes("<<")) return false;
  const stripped = stripQuoted(command);
  const re = /(?:^|[;&|(\n]|\bthen\b|\bdo\b|\{)\s*sleep\s+[0-9]/g;
  return re.test(stripped);
}

/** Blank quoted segments so a literal sleep inside a string never matches. */
function stripQuoted(command) {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return out + " ";
      out += " ".repeat(end - i + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        if (command[j] === "\\") { j += 2; continue; }
        if (command[j] === '"') { closed = true; break; }
        j += 1;
      }
      if (!closed) return out + " ".repeat(command.length - out.length);
      out += " ".repeat(j - i + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Format milliseconds as a compact human string like "12m 34s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.round(ms / 1000);
  if (total < 60) return total + "s";
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? m + "m" : m + "m " + s + "s";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? h + "h" : h + "h " + mm + "m";
}

/** Render the metrics as a compact multi-line text report. */
export function renderReport(metrics) {
  const wall = metrics.wallMs > 0 ? metrics.wallMs : metrics.turnWallMs;
  const pct = (part) => wall > 0 ? Math.round((100 * part) / wall) + "%" : "-";

  const lines = [];
  lines.push("效率报告 · 当前会话");
  lines.push("");
  lines.push("墙钟总耗时（所有 step 累计）: " + formatDuration(wall));
  lines.push("  模型生成 : " + formatDuration(metrics.modelMs) + "  (" + pct(metrics.modelMs) + ")");
  lines.push("  工具执行 : " + formatDuration(metrics.toolMs) + "  (" + pct(metrics.toolMs) + ")");
  lines.push("  其中 sleep 空转 : " + formatDuration(metrics.sleepSeconds * 1000) + "  (" + metrics.sleepCalls + " 次)");
  lines.push("");
  lines.push("插件拦截前台 sleep : " + (metrics.interceptions ?? 0) + " 次（这些等待没有真正发生）");
  lines.push("步骤数 : " + metrics.steps);
  lines.push("");
  if (wall > 0) {
    const wasted = metrics.sleepSeconds * 1000;
    lines.push("注：工具执行占比越低、sleep 空转越接近 0，说明长任务走后台+通知，效率越高。");
    lines.push("（" + formatDuration(metrics.toolMs - wasted) + " 是真实的工具工作，其余 " + formatDuration(wasted) + " 是可优化的等待。）");
  }
  return lines.join("\n");
}
