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
    _commands: [],
    inject(names, cb) {
      const deps = {};
      if (names.includes("systemPrompt")) deps.systemPrompt = ctx.systemPrompt;
      if (names.includes("commands")) deps.commands = ctx.commands;
      cb(deps);
    },
    systemPrompt: {
      _sections: [],
      getSectionOrder() { return 1000; },
      section(s) { ctx.systemPrompt._sections.push(s); },
    },
    commands: {
      register(def) { ctx._commands.push(def); },
    },
    on(event, handler) { ctx._handlers[event] = handler; },
  };
  return ctx;
}

function check(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  console.log('ok  - ' + label);
}

const ev = (type, time, data = {}) => ({ type, seq: 0, time, data });

// 1) THE regression: config === undefined must not throw, defaults apply.
const ctx = makeCtx();
apply(ctx, undefined);
check(ctx.systemPrompt._sections.length === 1, 'prompt section registered with undefined config');
check(ctx.systemPrompt._sections[0].text.includes('120s'), 'prompt text states the budget fact');
check(typeof ctx._handlers['tools/pre-execute'] === 'function', 'pre-execute handler registered');

// 2) blind foreground sleep denied; normal + background allowed.
const preExec = ctx._handlers['tools/pre-execute'];
const deny = await preExec({ name: 'bash', arguments: { command: 'sleep 115' } }, async () => ({ kind: 'allow' }));
check(deny.kind === 'deny', 'blind sleep 115 denied');
check(/115s/.test(deny.reason), 'deny reason names the wait');
const allow = await preExec({ name: 'bash', arguments: { command: 'grep -r foo .' } }, async () => ({ kind: 'allow' }));
check(allow.kind === 'allow', 'normal command allowed');
const bg = await preExec({ name: 'bash', arguments: { command: 'sleep 115', run_in_background: true } }, async () => ({ kind: 'allow' }));
check(bg.kind === 'allow', 'run_in_background allowed');

// 3) /efficiency command registered and renders from session events.
check(ctx._commands.length === 1 && ctx._commands[0].name === 'efficiency', '/efficiency command registered');
const cmd = ctx._commands[0];
const events = [
  ev('turn/start', 1000, { turn: 1 }),
  ev('step/start', 1000, { turn: 1, step: 1 }),
  ev('assistant/message', 4000, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 } }),
  ev('tool/call', 4100, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'sleep 5; echo hi' }) }),
  ev('tool/result', 5100, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } }),
  ev('step/end', 5100, { turn: 1, step: 1 }),
  ev('turn/end', 5100, { turn: 1, reason: 'stop' }),
];
const ctxEvents = makeCtx();
apply(ctxEvents, undefined);
const cmd2 = ctxEvents._commands[0];
const agentWithSession = { session: { ownEvents: () => events } };
const res = await cmd2.handler({ agent: agentWithSession });
check(res.kind === 'success', '/efficiency returns success');
check(res.text.includes('模型生成'), 'report shows model time');
check(res.text.includes('sleep 空转'), 'report shows sleep idle');
check(/1 次/.test(res.text), 'report counts the one sleep call');
check(/1 次/.test(res.text) && res.text.includes('拦截前台 sleep : 0'), 'interception counter is 0 without deny');

// 4) interception counter reflects a real deny (same agent object identity).
const ctxDeny = makeCtx();
apply(ctxDeny, undefined);
const agent = { session: { ownEvents: () => events } };
const pe = ctxDeny._handlers['tools/pre-execute'];
await pe({ name: 'bash', arguments: { command: 'sleep 115' }, agent }, async () => ({ kind: 'allow' }));
const res2 = await ctxDeny._commands[0].handler({ agent });
check(res2.text.includes('拦截前台 sleep : 1'), 'interception counter reflects the deny');

// 5) enabled:false disables everything.
const ctxOff = makeCtx();
apply(ctxOff, { enabled: false });
check(ctxOff.systemPrompt._sections.length === 0 && Object.keys(ctxOff._handlers).length === 0 && ctxOff._commands.length === 0, 'enabled:false disables everything');

console.log('\nALL GOOD');
