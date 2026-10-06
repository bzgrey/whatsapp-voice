// Model evals. Run before switching any model (SPEC §10.7).
//
//   npm run evals -- classify                 synthetic urgent/trivial set
//   npm run evals -- classify --set real      your labelled real set (evals/real/, from export-sample)
//   npm run evals -- summary [--set real]     one-liners: required facts + LLM judge
//   npm run evals -- transcribe               evals/real/audio/*.ogg against *.txt (hand-corrected)
//   add --model <name> to try a different model for the task
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MODELS, type Models } from '../src/config/schema.ts';
import { normalizeName } from '../src/config/names.ts';
import { LLM } from '../src/llm/openai.ts';
import { Tasks } from '../src/llm/tasks.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { set: { type: 'string', default: 'synthetic' }, model: { type: 'string' }, judge: { type: 'string', default: 'gpt-6-luna' } },
});
const task = positionals[0];
const dir = path.join(import.meta.dirname, opts.set!);

const llm = new LLM(null);
if (!llm.available) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
const models: Models = { ...DEFAULT_MODELS };
if (opts.model) {
  if (task === 'classify') models.classify = opts.model;
  if (task === 'summary') models.summarize = opts.model;
  if (task === 'transcribe') models.transcribe = opts.model;
}
const tasks = new Tasks(llm, () => models);

const load = <T>(file: string): T[] => {
  const p = path.join(dir, file);
  if (!existsSync(p)) { console.error(`missing ${p}${opts.set === 'real' ? ' (run npm run export-sample, then label it)' : ''}`); process.exit(1); }
  return JSON.parse(readFileSync(p, 'utf8')) as T[];
};

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : 'n/a');

async function classify() {
  type Case = { chat: string; isGroup?: boolean; text: string; urgent: boolean | null; trivial: boolean | null };
  const cases = load<Case>('classify.json').filter((c) => c.urgent !== null && c.trivial !== null);
  const results = await pool(cases, 5, async (c) => ({ c, r: await tasks.classify(c.text, { chat: c.chat, isGroup: !!c.isGroup }) }));
  const tp = results.filter((x) => x.c.urgent && x.r.is_urgent).length;
  const fn = results.filter((x) => x.c.urgent && !x.r.is_urgent);
  const fp = results.filter((x) => !x.c.urgent && x.r.is_urgent);
  const trivialWrong = results.filter((x) => x.c.trivial !== x.r.is_trivial);
  console.log(`classify · ${models.classify} · ${cases.length} cases`);
  console.log(`  urgent recall    ${pct(tp, tp + fn.length)}   ← most important: a missed emergency`);
  console.log(`  urgent precision ${pct(tp, tp + fp.length)}`);
  console.log(`  trivial accuracy ${pct(cases.length - trivialWrong.length, cases.length)}`);
  for (const x of fn) console.log(`  MISSED URGENT: ${x.c.text}`);
  for (const x of fp) console.log(`  false urgent:  ${x.c.text}`);
  for (const x of trivialWrong) console.log(`  trivial should be ${x.c.trivial}: ${x.c.text}`);
}

async function summary() {
  type Case = { chat: string; isGroup?: boolean; lines: string[]; must: string[] };
  const cases = load<Case>('summaries.json');
  const JUDGE = `You grade a one-line spoken summary of the NEW messages (marked "(new)") in a WhatsApp chat.
Return JSON {"score": 1-5, "reason": string}. 5 = accurate, complete on what matters, short (≤15 words), natural English. Deduct for anything invented, missing asks/times, or too long.`;
  const results = await pool(cases, 4, async (c) => {
    const line = await tasks.summaryLine(c.chat, !!c.isGroup, c.lines);
    const missing = c.must.filter((w) => !normalizeName(line).includes(normalizeName(w)));
    const j = await llm.json<{ score: number; reason: string }>('eval_judge', opts.judge!, JUDGE, `Chat:\n${c.lines.join('\n')}\n\nSummary: ${line}`);
    return { c, line, missing, j };
  });
  console.log(`summary · ${models.summarize} · judge ${opts.judge} · ${cases.length} cases`);
  const avg = results.reduce((s, x) => s + (x.j.score ?? 0), 0) / results.length;
  console.log(`  judge average ${avg.toFixed(2)} / 5; facts present ${pct(results.filter((x) => !x.missing.length).length, results.length)}`);
  for (const x of results) {
    console.log(`  [${x.j.score}] ${x.c.chat}: ${x.line}${x.missing.length ? `   MISSING: ${x.missing.join(', ')}` : ''}`);
    if (x.j.score < 4) console.log(`      judge: ${x.j.reason}`);
  }
}

/** Word error rate after normalization (works for Hebrew and English). */
export function wer(ref: string, hyp: string): number {
  const r = normalizeName(ref).split(' ').filter(Boolean);
  const h = normalizeName(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return r.length ? d[r.length]![h.length]! / r.length : 0;
}

async function transcribe() {
  const audioDir = path.join(import.meta.dirname, 'real', 'audio');
  if (!existsSync(audioDir)) { console.error(`put voice notes (.ogg) and hand-corrected transcripts (.txt, same name) in ${audioDir}`); process.exit(1); }
  const files = readdirSync(audioDir).filter((f) => /\.(ogg|opus|mp3|m4a|wav)$/.test(f) && existsSync(path.join(audioDir, f.replace(/\.\w+$/, '.txt'))));
  const results = await pool(files, 3, async (f) => {
    const hyp = await tasks.transcribe(readFileSync(path.join(audioDir, f)), f, 30);
    const ref = readFileSync(path.join(audioDir, f.replace(/\.\w+$/, '.txt')), 'utf8');
    return { f, w: wer(ref, hyp), hyp };
  });
  console.log(`transcribe · ${models.transcribe} · ${files.length} files`);
  console.log(`  mean WER ${(100 * results.reduce((s, x) => s + x.w, 0) / (results.length || 1)).toFixed(1)}%`);
  for (const x of results) console.log(`  ${(100 * x.w).toFixed(0).padStart(3)}%  ${x.f}: ${x.hyp}`);
}

const run = { classify, summary, transcribe }[task as 'classify'];
if (!run) { console.error('usage: npm run evals -- classify|summary|transcribe [--set real] [--model name]'); process.exit(1); }
await run();
