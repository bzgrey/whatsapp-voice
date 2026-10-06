import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.ts';
import { Store } from '../src/db/store.ts';
import { ConfigSync } from '../src/config/sync.ts';
import type { MessageRow, NewMessage } from '../src/db/types.ts';
import type { Sender } from '../src/briefing/session.ts';

export const NOW = 1_790_000_000;

export function makeStore() {
  return new Store(openDb(':memory:'));
}

export function makeConfig(store: Store, yaml: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, yaml);
  const sync = new ConfigSync(store, file);
  sync.load();
  return sync;
}

let seq = 0;

/** Insert a message (and its chat) directly. */
export function addMessage(store: Store, chat: string, fields: Partial<NewMessage> = {}): number {
  const isGroup = chat.endsWith('@g.us');
  if (!store.getChat(chat)) store.upsertChat({ jid: chat, is_group: isGroup }, NOW);
  return store.insertMessage({
    id: `m${++seq}`,
    chat_jid: chat,
    sender_jid: isGroup ? '972500000009@s.whatsapp.net' : chat,
    sender_name: null,
    from_me: 0,
    type: 'text',
    raw_text: 'hello',
    media_ref: null,
    is_urgent: 0,
    is_trivial: 0,
    quoted_id: null,
    mentions_me: 0,
    created_at: NOW - 600 + seq,
    ...fields,
  })!;
}

export class FakeSender implements Sender {
  sent: { jid: string; text: string; quoted: MessageRow | null }[] = [];
  fail = false;
  async sendText(jid: string, text: string, quoted: MessageRow | null) {
    if (this.fail) throw new Error('not connected');
    this.sent.push({ jid, text, quoted });
  }
}

export const MOM = '972501111111@s.whatsapp.net';
export const YOSSI = '972502222222@s.whatsapp.net';
export const DOVID_C = '972503333333@s.whatsapp.net';
export const DOVID_L = '972504444444@s.whatsapp.net';
export const FAMILY = '120363000000000001@g.us';
export const BUILDING = '120363000000000002@g.us';
export const SHIUR = '120363000000000003@g.us';

/** A small address book: Mom, Yossi Cohen, two Dovids, and three groups. */
export function seedPeople(store: Store) {
  store.upsertContact({ jid: MOM, name: 'Mom' });
  store.upsertContact({ jid: YOSSI, name: 'Yossi Cohen', push_name: 'Yossi' });
  store.upsertContact({ jid: DOVID_C, name: 'Dovid Cohen' });
  store.upsertContact({ jid: DOVID_L, name: 'Dovid Levi' });
  store.upsertChat({ jid: FAMILY, name: 'Family', is_group: true }, NOW);
  store.upsertChat({ jid: BUILDING, name: 'Building committee', is_group: true }, NOW);
  store.upsertChat({ jid: SHIUR, name: 'Shiur', is_group: true }, NOW);
}

export const CONFIG = `# my settings
my_phone: "0535551234"
pin: "4321"
flagged:
  - Mom # always
muted:
  - Building committee
whitelisted_groups:
  - Family
`;
