// End-to-end verification harness for index.js (NOT part of `node --test test/`).
// Requires `@deepseek-ai/schemastery` on the resolve path, which is only true
// inside a booted DSH profile. Run it from a profile checkout after:
//   ln -s <dsh>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
//   node verify/apply.test.mjs

import { apply } from "../lib/index.js";

// --- minimal mock cordis context ---
function makeCtx() {
  const ctx = {
    _handlers: {},
    inject(_names, cb) {
      cb({ systemPrompt: ctx.systemPrompt });
    },
    systemPrompt: {
      _sections: [],
      getSectionOrder() { return 1000; },
      section(s) { ctx.systemPrompt._sections.push(s); },
    },
    on(event, handler) { ctx._handlers[event] = handler; },
  };
  return ctx;
}

function check(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  console.log('ok  - ' + label);
}

// 1) THE regression: cordis passes config === undefined when the bundle row
//    has no `config:` block. apply() must not throw and must use schema defaults.
const ctx = makeCtx();
apply(ctx, undefined);
check(ctx.systemPrompt._sections.length === 1, 'prompt section registered with undefined config');
check(ctx.systemPrompt._sections[0].text.includes('120s'), 'prompt text states the budget fact');
check(typeof ctx._handlers['tools/pre-execute'] === 'function', 'pre-execute handler registered');

// 2) a blind foreground sleep is denied
const preExec = ctx._handlers['tools/pre-execute'];
const deny = await preExec({ name: 'bash', arguments: { command: 'sleep 115' } }, async () => ({ kind: 'allow' }));
check(deny.kind === 'deny', 'blind sleep 115 denied');
check(/115s/.test(deny.reason), 'deny reason names the wait');

// 3) normal command and run_in_background pass through
const allow = await preExec({ name: 'bash', arguments: { command: 'grep -r foo .' } }, async () => ({ kind: 'allow' }));
check(allow.kind === 'allow', 'normal command allowed');
const bg = await preExec({ name: 'bash', arguments: { command: 'sleep 115', run_in_background: true } }, async () => ({ kind: 'allow' }));
check(bg.kind === 'allow', 'run_in_background allowed');

// 4) explicit config still applies
const ctx2 = makeCtx();
apply(ctx2, { enabled: false });
check(ctx2.systemPrompt._sections.length === 0 && Object.keys(ctx2._handlers).length === 0, 'enabled:false disables everything');

console.log('\nALL GOOD');
