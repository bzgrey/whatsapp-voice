// Text-mode phone call: the real briefing state machine and tools, driven by a
// text model instead of a voice model. Nothing is ever sent to WhatsApp.
//
//   npm run simulate -- --demo            throwaway inbox with sample messages
//   npm run simulate                      your real messages.db (read-write: marks things heard!)
//   npm run simulate -- --caller 0521234567   simulate another phone (PIN path)
//   npm run simulate -- --demo --manual   no model: type tool calls yourself
//
// While running: type what you'd say. Keypad: /1 /2 /3 /9 /#  (PIN digits: /1234).
// /drop simulates the line dropping, /quit hangs up normally.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CallSession, type Sender } from '../src/briefing/session.ts';
import { ConfigSync } from '../src/config/sync.ts';
import { openDb } from '../src/db/index.ts';
import { Store } from '../src/db/store.ts';
import type { MessageRow } from '../src/db/types.ts';
import { env, nowSec } from '../src/env.ts';
import { LLM, type ChatMessage } from '../src/llm/openai.ts';
import { Tasks } from '../src/llm/tasks.ts';
import { monthToDate } from '../src/llm/usage.ts';
import { chatCompletionTools, INSTRUCTIONS } from '../src/call/tools.ts';
import { seedDemo } from './demo-data.ts';

const { values: args } = parseArgs({
  options: {
    demo: { type: 'boolean', default: false },
    manual: { type: 'boolean', default: false },
    caller: { type: 'string' },
    db: { type: 'string' },
  },
});

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let dbFile = args.db ?? env.DB_PATH;
let configFile = env.CONFIG_PATH;
if (args.demo) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-sim-'));
  dbFile = path.join(dir, 'demo.db');
  configFile = path.join(dir, 'config.yaml');
}
const store = new Store(openDb(dbFile));
if (args.demo) seedDemo(store, configFile, nowSec());
const config = new ConfigSync(store, configFile);
config.load();

const llm = new LLM(store);
const tasks = new Tasks(llm, () => config.config.models);
const manual = args.manual || !llm.available;
if (!args.manual && !llm.available) console.log(dim('OPENAI_API_KEY not set: manual mode (type tool calls yourself).'));

const sender: Sender = {
  async sendText(jid: string, text: string, quoted: MessageRow | null) {
    console.log(bold(`\n[WOULD SEND to ${jid}${quoted ? ` as a reply to ${quoted.id}` : ''}]: ${text}\n`));
  },
};

const caller = args.caller ?? config.config.my_phone;
const session = new CallSession({ store, config, tasks: llm.available ? tasks : null, sender, now: nowSec }, caller);
const tools = chatCompletionTools();
const messages: ChatMessage[] = [{
  role: 'system',
  content: `${INSTRUCTIONS}\n\n(This is a text simulation of the phone call: write exactly what you would say aloud. Server notes arrive as user messages in [brackets].)`,
}];
let hangup = false;

async function runModel() {
  for (let i = 0; i < 8; i++) {
    const msg = await llm.chat('simulate', config.config.models.simulate, messages, { tools });
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
    if (msg.content) {
      console.log(`\n${bold('ASSISTANT:')} ${msg.content}\n`);
      session.confirmSpoken(msg.content);
    }
    if (!msg.tool_calls?.length) break;
    for (const tc of msg.tool_calls) {
      let a: Record<string, unknown> = {};
      try { a = JSON.parse(tc.function.arguments || '{}'); } catch { /* model sent bad JSON; tool gets no args */ }
      console.log(dim(`  → ${tc.function.name}(${JSON.stringify(a)})`));
      const out = await session.tool(tc.function.name, a);
      console.log(dim(out.output.split('\n').map((l) => `    ${l}`).join('\n')));
      if (out.hangup) hangup = true;
      if (out.pauseMs) console.log(dim(`  (pause ${(out.pauseMs / 1000).toFixed(1)} s)`));
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.output });
    }
  }
}

function show(output: string) {
  console.log(`\n${bold('SERVER →')} ${output}\n`);
}

async function serverNote(text: string) {
  if (manual) return show(text);
  messages.push({ role: 'user', content: `[${text}]` });
  await runModel();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Start reading now so piped input isn't lost while the opening is generated.
const input = rl[Symbol.asyncIterator]();
let closed = false;
rl.on('close', () => (closed = true));
const prompt = () => { if (!closed) rl.prompt(); };
console.log(dim(`call from ${caller || '(no caller ID)'} · db ${dbFile}${manual ? ' · manual' : ` · model ${config.config.models.simulate}`}`));
const opening = await session.opening();
if (opening.hangup) hangup = true;
await serverNote(opening.output);

rl.setPrompt('YOU: ');
if (!hangup) prompt();
while (!hangup) {
  const next = await input.next();
  if (next.done) break;
  const line = String(next.value).trim();
  if (!process.stdin.isTTY && line) console.log(line);
  if (!line) { prompt(); continue; }
  if (line === '/quit') { await serverNote((await session.tool('end_call', {})).output); break; }
  if (line === '/drop') { console.log(dim('(line dropped)')); break; }
  if (line.startsWith('/')) {
    for (const d of line.slice(1)) {
      const out = await session.dtmf(d);
      if (!out) continue;
      if (out.hangup) hangup = true;
      await serverNote(`Keypad: ${out.output}`);
    }
    if (hangup) break;
    prompt();
    continue;
  }
  if (manual) {
    const [name, ...rest] = line.split(' ');
    const out = await session.tool(name!, rest.length ? JSON.parse(rest.join(' ')) : {});
    show(out.output);
    session.confirmSpoken();
    if (out.hangup) break;
    prompt();
    continue;
  }
  messages.push({ role: 'user', content: line });
  await runModel();
  if (hangup) break;
  prompt();
}

session.end();
rl.close();
const { total_usd } = monthToDate(store);
console.log(dim(`call ended · month-to-date API cost in this db: $${total_usd.toFixed(4)}`));
store.db.close();
