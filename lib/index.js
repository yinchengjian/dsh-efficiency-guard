/**
 * efficiency-guard: a DSH plugin that removes the dominant source of dead time
 * in long sessions.
 *
 * It contributes one system-prompt section (the background-first recipe plus
 * the per-call budget facts) and one tools/pre-execute listener that denies a
 * foreground sleep above a threshold with corrective feedback.
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
 * - A config: on this row is validated fail-loud at load, never silently ignored.
 * @module dsh-efficiency-guard
 */

import z from "@deepseek-ai/schemastery";
import { buildSleepReason, EFFICIENCY_SECTION, inspectSleepCall, resolveGuardConfig } from "./detect.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "efficiency-guard";

/** Fallback prompt order: just ahead of the bash tool description at 1000. */
const SECTION_ORDER_BEFORE_BASH = 990;

/** Model-facing and guard configuration; schema defaults are the shipped policy. */
export const Config = z.object({
  /** Master switch for both the prompt section and the guard. */
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
 * Install the prompt section and the sleep guard.
 * @param ctx - plugin context; every effect is disposed with it.
 * @param config - schema-valid configuration with plugin defaults applied.
 */
export function apply(ctx, config) {
  const cfg = resolveGuardConfig(config);
  if (cfg.enabled === false) return;

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

  if (cfg.guardSleep === false) return;

  ctx.on("tools/pre-execute", async (exec, next) => {
    const hit = inspectSleepCall(exec, cfg);
    if (hit === undefined) return next();
    return { kind: "deny", reason: buildSleepReason(hit, cfg.minSleepSeconds) };
  });
}

export default apply;
