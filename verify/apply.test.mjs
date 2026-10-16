// End-to-end verification harness for index.js (NOT part of `node --test test/`).
// Requires `@deepseek-ai/schemastery` on the resolve path, which is only true
// inside a booted DSH profile. Run it from a profile checkout after:
//   ln -s <dsh>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
//   node verify/apply.test.mjs

import { apply, Config } from "../lib/index.js";
import z from "@deepseek-ai/schemastery";

// --- minimal mock cordis context ---
function makeCtx() {
  const ctx = {
    _injected: {},
    _handlers: {},
    inject(names, cb) {
      // resolve deps: systemPrompt is provided
      const depCtx = { systemPrompt: ctx.systemPrompt };
      cb(depCtx);
    },
    systemPrompt: {
      _sections: [],
      getSectionOrder(name) { return 1000; }, // TOOL_BASH
      section(s) { ctx.systemPrompt._sections.push(s); },
    },
    on(event, handler) { ctx._handlers[event] = handler; },
  };
  return ctx;
}

// 1) resolve default config through the real schema
const cfg = z(Config)({}); // schemastery schema acts as a validator/coercer
console.log("resolved config:", JSON.stringify(cfg));

// 2) apply
const ctx = makeCtx();
apply(ctx, cfg);

const section = ctx.systemPrompt._sections[0];
console.log("\nprompt section name:", section?.name, "| order:", section?.order);
console.log("prompt text has 120s fact:", (section?.text||"").includes("120s"));

const preExec = ctx._handlers["tools/pre-execute"];
console.log("pre-execute handler registered:", typeof preExec === "function");

// 3) simulate a bash call with sleep 115 -> should deny
const decision = await preExec({ name:"bash", arguments:{ command:"sleep 115" } }, async () => ({kind:"allow"}));
console.log("\nblind sleep decision:", JSON.stringify(decision.kind), "->", JSON.stringify(decision.reason?.slice(0,60)));

// 4) a normal bash call -> allow (passes through to next)
const allow = await preExec({ name:"bash", arguments:{ command:"grep -r foo ." } }, async () => ({kind:"allow"}));
console.log("normal command decision:", allow.kind);

// 5) run_in_background true -> allow
const bg = await preExec({ name:"bash", arguments:{ command:"sleep 115", run_in_background:true } }, async () => ({kind:"allow"}));
console.log("run_in_background decision:", bg.kind);

// 6) disabled config -> no handlers, no section
const ctx2 = makeCtx();
apply(ctx2, z(Config)({ enabled:false }));
console.log("\ndisabled: sections=", ctx2.systemPrompt._sections.length, " handlers=", Object.keys(ctx2._handlers).length);

console.log("\nALL GOOD");

