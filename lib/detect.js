/**
 * Pure detection and policy logic for efficiency-guard.
 *
 * This module has no imports on purpose: it is unit-testable from a plain
 * checkout where the @deepseek-ai/* packages are only resolvable inside a
 * booted DSH profile.
 * @module dsh-efficiency-guard/detect
 */

/** Seconds per supported duration unit suffix. A bare number is already seconds. */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 };

/**
 * Replace every single- and double-quoted shell segment with spaces, so a
 * literal sleep inside a string argument never counts as a wait that actually
 * runs in the foreground. The replacement is length-preserving.
 * @param command - raw shell command text.
 * @returns the same-length text with quoted bodies blanked.
 */
export function stripQuoted(command) {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return out + " ".repeat(command.length - out.length);
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

/**
 * Convert one sleep operand into seconds.
 * @param value - the numeric text as matched.
 * @param unit - the optional s/m/h suffix.
 * @returns seconds, or undefined when the operand is not a finite positive number.
 */
export function parseSleepSeconds(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const factor = UNIT_SECONDS[unit] === undefined ? 1 : UNIT_SECONDS[unit];
  return n * factor;
}

/** A command position immediately before a fresh shell command begins. */
const SLEEP_RE = new RegExp(
  "(?:^|[;&|(\\n]|\\bthen\\b|\\bdo\\b|\\{)\\s*sleep\\s+([0-9]+(?:\\.[0-9]+)?)\\s*([smh]?)(?![0-9A-Za-z_])",
  "g"
);

/**
 * Find the longest foreground sleep in a shell command.
 *
 * A match only counts when the sleep token starts a command: at the start of
 * the string or after a shell separator (;, &&, ||, |, (, newline, then, do, {).
 * Commands containing a heredoc (<<) are never inspected, because text written
 * into a script file is not a foreground wait.
 * @param command - raw shell command text.
 * @returns the largest wait and its occurrence count, or undefined.
 */
export function detectForegroundSleep(command) {
  if (typeof command !== "string" || command.length === 0) return undefined;
  if (command.indexOf("<<") !== -1) return undefined;
  const stripped = stripQuoted(command);
  SLEEP_RE.lastIndex = 0;
  let best;
  let count = 0;
  let m;
  while ((m = SLEEP_RE.exec(stripped)) !== null) {
    const seconds = parseSleepSeconds(m[1], m[2]);
    if (seconds === undefined) continue;
    count += 1;
    if (best === undefined || seconds > best) best = seconds;
  }
  if (best === undefined) return undefined;
  return { seconds: best, count };
}

/**
 * Fail-loud normalization of the plugin config.
 *
 * The schemastery Config on the entry point already checked types and filled
 * defaults; this pass owns the semantic rules and compiles the allow patterns
 * once, so a bad regex fails at load rather than at the first tool call.
 * @param config - schema-valid configuration.
 * @returns the normalized configuration with compiled matchers.
 */
export function resolveGuardConfig(config) {
  if (config === null || typeof config !== "object") {
    throw new Error("efficiency-guard: resolveGuardConfig needs an object with schema defaults applied (call sites should pass z(Config)(config ?? {}) first)");
  }
  const minSleepSeconds = config.minSleepSeconds;
  if (!Number.isFinite(minSleepSeconds) || minSleepSeconds <= 0) {
    throw new Error("efficiency-guard: minSleepSeconds must be a positive number, got " + JSON.stringify(minSleepSeconds));
  }
  if (!Array.isArray(config.toolNames) || config.toolNames.length === 0) {
    throw new Error("efficiency-guard: toolNames must be a non-empty array of tool names");
  }
  if (!Array.isArray(config.allowPatterns)) {
    throw new Error("efficiency-guard: allowPatterns must be an array of regular expression strings");
  }
  const compiledAllow = config.allowPatterns.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new Error("efficiency-guard: invalid allowPatterns entry " + JSON.stringify(pattern) + ": " + message);
    }
  });
  return Object.assign({}, config, { compiledAllow });
}

/**
 * Decide whether one pending tool call is a blind foreground wait worth blocking.
 * @param exec - the tool execution about to dispatch (name plus parsed arguments).
 * @param config - configuration from resolveGuardConfig.
 * @returns the offending wait, or undefined to leave the call alone.
 */
export function inspectSleepCall(exec, config) {
  if (config.enabled === false || config.guardSleep === false) return undefined;
  if (exec === null || typeof exec !== "object") return undefined;
  if (config.toolNames.indexOf(exec.name) === -1) return undefined;
  const args = exec.arguments;
  if (args === null || typeof args !== "object") return undefined;
  if (args.run_in_background === true) return undefined;
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  if (config.compiledAllow.some((re) => re.test(command))) return undefined;
  const hit = detectForegroundSleep(command);
  if (hit === undefined || hit.seconds < config.minSleepSeconds) return undefined;
  return { seconds: hit.seconds, count: hit.count, command };
}

/**
 * Build the corrective, model-facing denial reason.
 * @param hit - the wait found by inspectSleepCall.
 * @param minSleepSeconds - the configured threshold, quoted back for tunability.
 * @returns the denial reason text.
 */
export function buildSleepReason(hit, minSleepSeconds) {
  const wait = Math.round(hit.seconds);
  const what = hit.count === 1 ? "a blind sleep" : hit.count + " blind sleeps";
  return [
    "Blocked by efficiency-guard: this foreground command spends about " + wait + "s in " + what + ", consuming the tool-call budget without producing anything.",
    "",
    "Do this instead:",
    "- Start the long work itself with run_in_background: true (bash), then do independent steps in later calls. The harness notifies you when it settles, and job_output reads its output.",
    "- To wait on something already running, call job_output with wait: true. It returns as soon as the job settles instead of always burning the full sleep, and it may wait up to the job cap (600s by default) rather than the 120s call ceiling.",
    "- If you must poll, poll once per step and use the time between steps for other work. Never chain sleep 115 calls to approximate a long wait.",
    "- Batch independent reads and commands into one run_code with Promise.all so a single step replaces several.",
    "",
    "Set minSleepSeconds above " + wait + " or guardSleep: false in the efficiency-guard config to allow deliberate waits.",
  ].join("\n");
}

/**
 * The system-prompt section: the facts a model needs to stop polling in the
 * first place. Assembled once per request, so it stays short and imperative.
 */
export const EFFICIENCY_SECTION = [
  "## Tool-call budget and elapsed time",
  "",
  "Every tool call has a hard wall-clock ceiling (120s by default, 600s maximum) and every model step costs a round trip. Elapsed time is a first-class cost: a call that sleeps produces nothing.",
  "",
  "- Long command (over roughly 60s, including data syncs, backtests, and builds): run it with run_in_background: true and keep working on independent steps. You are notified when it settles; job_output reads its output.",
  "- Never run a foreground sleep to wait for a job, a sync, or a build, and never chain short sleeps. To wait on something already running, use job_output with wait: true.",
  "- Batch independent work: issue the reads, searches, and commands you already know you need together in one run_code with Promise.all([...]). One batched step replaces many serial ones and saves a round trip each time.",
  "- Prefer one command that prints its own progress and exits over a sequence of sleep-and-grep probes. If a step needs minutes, start it in the background, say what else you will do meanwhile, then collect it.",
  "- Report elapsed-sensitive conclusions from the job's recorded output, not from a fresh probe.",
].join("\n");
