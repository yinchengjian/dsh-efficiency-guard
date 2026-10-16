/**
 * efficiency-guard: a DSH plugin that removes the dominant source of dead time
 * in long sessions and reports where the wall-clock went.
 *
 * Three capabilities:
 * 1. A system-prompt section teaching the background-first recipe and budget facts.
 * 2. A tools/pre-execute guard that denies blind foreground sleeps above a
 *    threshold with corrective feedback (and counts each denial).
 * 3. A /efficiency slash command that replays the current session's event log
 *    and reports the model/tool/sleep split plus the guard's interception count.
 *
 * Denying is the only lever that fires BEFORE the wait is burned: pre-execute
 * cannot rewrite arguments, and post-execute only runs once the time is already
 * gone.
 *
 * Design notes:
 * - The sleep check sees nested run_code sub-dispatches too, because a PTC
 *   sub-call flows through the same pre-execute waterfall as a direct call.
 * - run_in_background: true is always allowed, so the guard pushes work onto the
 *   path that lets the model do something else while it runs.
 * - Metrics come from the durable session log (session.ownEvents()), so they
 *   survive restarts and are never lost; only the interception counter is live,
 *   because a denied call emits no tool/result event.
 * @module dsh-efficiency-guard
 */

import z from "@deepseek-ai/schemastery";
import { buildSleepReason, EFFICIENCY_SECTION, inspectSleepCall, resolveGuardConfig } from "./detect.js";
import { computeSessionMetrics, renderReport } from "./metrics.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "efficiency-guard";

/** Fallback prompt order: just ahead of the bash tool description at 1000. */
const SECTION_ORDER_BEFORE_BASH = 990;

/** Model-facing and guard configuration; schema defaults are the shipped policy. */
export const Config = z.object({
  /** Master switch for the prompt section, the guard, and the command. */
  enabled: z.boolean().default(true),
  /** Whether to deny blind foreground waits; the prompt section is independent. */
  guardSleep: z.boolean().default(true),
  /** Shortest foreground sleep that is treated as a wasted wait. */
  minSleepSeconds: z.number().default(20),
  /** Tools whose arguments are inspected for a command string. */
  toolNames: z.array(z.string()).default(["bash"]),
  /** Regular expression sources; a command matching any of them is never denied. */
  allowPatterns: z.array(z.string()).default([]),
});

/**
 * Install the prompt section, the sleep guard, and the /efficiency command.
 * @param ctx - plugin context; every effect is disposed with it.
 * @param config - schema-valid configuration with plugin defaults applied.
 */
export function apply(ctx, config) {
  // cordis passes `config` as `undefined` when the bundle row omits a `config:`
  // block, so materialize the schema defaults before the semantic pass. The
  // schema keeps the defaults in one place and a bad value still fails loud.
  const cfg = resolveGuardConfig(z(Config)(config ?? {}));
  if (cfg.enabled === false) return;

  // Live interception counter keyed by agent. Denied calls produce no tool/result
  // event, so the session log cannot see them; this is the only live state.
  const interceptions = new WeakMap(); // Agent -> number

  ctx.inject(["systemPrompt"], (promptCtx) => {
    const sectionOrder = typeof promptCtx.systemPrompt.getSectionOrder === "function"
      ? promptCtx.systemPrompt.getSectionOrder("TOOL_BASH") - 10
      : SECTION_ORDER_BEFORE_BASH;
    promptCtx.systemPrompt.section({
      name: "efficiency:budget",
      order: Number.isFinite(sectionOrder) ? sectionOrder : SECTION_ORDER_BEFORE_BASH,
      text: EFFICIENCY_SECTION,
    });
  });

  if (cfg.guardSleep !== false) {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const hit = inspectSleepCall(exec, cfg);
      if (hit === undefined) return next();
      if (exec.agent) interceptions.set(exec.agent, (interceptions.get(exec.agent) ?? 0) + 1);
      return { kind: "deny", reason: buildSleepReason(hit, cfg.minSleepSeconds) };
    });
  }

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: "dsh-efficiency-guard/efficiency",
      name: "efficiency",
      description: "Show the current session's efficiency split (model vs tool vs idle waits)",
      handler: ({ agent }) => {
        const events = sessionEvents(agent);
        const count = agent ? (interceptions.get(agent) ?? 0) : 0;
        if (events === undefined) {
          return { kind: "error", text: "efficiency-guard: no session events available for this agent." };
        }
        const metrics = computeSessionMetrics(events, count);
        return { kind: "success", text: renderReport(metrics) };
      },
    });
  });
}

/**
 * Read the live session event log for an agent. The runtime Agent exposes its
 * live session directly as `agent.session` (its log is the durable source of
 * truth), so read it straight from there instead of round-tripping through the
 * session store.
 * @param agent - the agent owning the command.
 * @returns the event array, or undefined when unavailable.
 */
function sessionEvents(agent) {
  if (agent === undefined || agent === null) return undefined;
  const session = agent.session;
  if (session === undefined || typeof session.ownEvents !== "function") return undefined;
  return session.ownEvents();
}

export default apply;
