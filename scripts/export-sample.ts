// Dump a sample of real chats from the local DB into evals/real/ (gitignored) for labelling.
//   npm run export-sample -- [--n 150]
// Then edit evals/real/classify.json: set "urgent" and "trivial" to true/false
// (the model's current guesses are prefilled as a starting point), and add
// required facts to "must" in evals/real/summaries.json. Unlabelled cases are skipped.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/index.ts';
import { Store } from '../src/db/store.ts';
import { env, nowSec, RETENTION_SECONDS } from '../src/env.ts';
import { displayName } from '../src/config/names.ts';
import { messageContent } from '../src/briefing/render.ts';
import { chatContext } from '../src/ingest/summaries.ts';
import type { MessageRow } from '../src/db/types.ts';

const { values } = parseArgs({ options: { n: { type: 'string', default: '150' } } });
const store = new Store(openDb(env.DB_PATH));
const out = path.join(import.meta.dirname, '..', 'evals', 'real');
mkdirSync(out, { recursive: true });

const rows = store.db.prepare(`
  SELECT * FROM messages WHERE from_me = 0 AND type NOT IN ('reaction', 'sticker') ORDER BY RANDOM() LIMIT ?
`).all(Number(values.n)) as MessageRow[];
const classify = rows.map((m) => ({
  chat: displayName(store, m.chat_jid),
  isGroup: m.chat_jid.endsWith('@g.us'),
  text: messageContent(m),
  urgent: null,
  trivial: null,
  model_urgent: m.is_urgent === null ? null : !!m.is_urgent,
  model_trivial: m.is_trivial === null ? null : !!m.is_trivial,
}));
writeFileSync(path.join(out, 'classify.json'), JSON.stringify(classify, null, 2));

const chats = store.db.prepare('SELECT DISTINCT chat_jid FROM messages WHERE from_me = 0 ORDER BY RANDOM() LIMIT 25').all() as { chat_jid: string }[];
const summaries = chats.map(({ chat_jid }) => ({
  chat: displayName(store, chat_jid),
  isGroup: chat_jid.endsWith('@g.us'),
  lines: chatContext(store, chat_jid, nowSec()).slice(-15),
  must: [] as string[],
})).filter((s) => s.lines.length);
writeFileSync(path.join(out, 'summaries.json'), JSON.stringify(summaries, null, 2));

console.log(`wrote ${classify.length} messages and ${summaries.length} chats to ${out} (last ${RETENTION_SECONDS / 86400} days only)`);
