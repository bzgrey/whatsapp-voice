import { describe, expect, it } from 'vitest';
import { Ingest } from '../src/ingest/ingest.ts';
import { extract, type RawMessage } from '../src/ingest/extract.ts';
import { JobWorker, MAX_ATTEMPTS } from '../src/ingest/jobs.ts';
import { BUILDING, CONFIG, FAMILY, makeConfig, makeStore, MOM, NOW, seedPeople, SHIUR, YOSSI } from './helpers.ts';

const ME = { pn: '972535551234@s.whatsapp.net', lid: '555@lid' };

function setup() {
  const store = makeStore();
  seedPeople(store);
  const config = makeConfig(store, CONFIG);
  const ingest = new Ingest(store, config, () => ME, () => NOW);
  let n = 0;
  const feed = (raw: Omit<RawMessage, 'key'> & { key: Partial<RawMessage['key']> }) =>
    ingest.handle(extract({ messageTimestamp: NOW, ...raw, key: { id: `k${++n}`, fromMe: false, ...raw.key } } as RawMessage)!, () => '{"ref":1}');
  return { store, config, ingest, feed };
}

describe('ingest', () => {
  it('stores DMs and queues classification and a debounced summary', () => {
    const { store, feed } = setup();
    const id = feed({ key: { remoteJid: YOSSI }, message: { conversation: 'can I borrow your sefer?' }, pushName: 'Yossi' });
    expect(id).not.toBeNull();
    const kinds = store.db.prepare('SELECT kind, run_after FROM jobs ORDER BY id').all() as { kind: string; run_after: number }[];
    expect(kinds.map((k) => k.kind)).toEqual(['classify', 'summarize']);
    expect(kinds[1]!.run_after).toBeGreaterThan(NOW);
    feed({ key: { remoteJid: YOSSI }, message: { conversation: 'thursday?' } });
    expect((store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'summarize'").get() as { n: number }).n).toBe(1);
  });

  it('drops muted chats and plain messages in mentions-only groups', () => {
    const { store, feed } = setup();
    expect(feed({ key: { remoteJid: BUILDING, participant: YOSSI }, message: { conversation: 'water off tomorrow' } })).toBeNull();
    expect(feed({ key: { remoteJid: SHIUR, participant: YOSSI }, message: { conversation: 'shiur at 9' } })).toBeNull();
    expect(feed({ key: { remoteJid: SHIUR, participant: YOSSI }, message: { extendedTextMessage: { text: '@you coming?', contextInfo: { mentionedJid: [ME.lid] } } } })).not.toBeNull();
    expect(feed({ key: { remoteJid: FAMILY, participant: YOSSI }, message: { conversation: 'shabbat shalom' } })).not.toBeNull();
    expect(store.unheard().map((m) => m.chat_jid).sort()).toEqual([FAMILY, SHIUR].sort());
  });

  it('treats a group first seen in the chat-list sync as mentions-only', () => {
    const { store, config, feed } = setup();
    config.upsertChat({ jid: '120363999@g.us', is_group: true }, NOW);
    expect(store.getChat('120363999@g.us')!.tier).toBe('mentions');
    expect(feed({ key: { remoteJid: '120363999@g.us', participant: YOSSI }, message: { conversation: 'hi all' } })).toBeNull();
    config.upsertChat({ jid: YOSSI, archived: true }, NOW);
    expect(store.getChat(YOSSI)!.tier).toBe('muted');
  });

  it('stores my own messages as context only, and marks obvious trivia without the API', () => {
    const { store, feed } = setup();
    feed({ key: { remoteJid: MOM, fromMe: true }, message: { conversation: 'coming thursday' } });
    feed({ key: { remoteJid: MOM }, message: { conversation: '👍' } });
    feed({ key: { remoteJid: MOM }, message: { conversation: 'no' } }); // an answer, not trivia
    const rows = store.db.prepare('SELECT from_me, is_trivial FROM messages ORDER BY rowid').all();
    expect(rows).toEqual([{ from_me: 1, is_trivial: 0 }, { from_me: 0, is_trivial: 1 }, { from_me: 0, is_trivial: null }]);
    expect((store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'classify'").get() as { n: number }).n).toBe(1);
  });

  it('counts everything before my reply as heard, and keeps what comes after', () => {
    const { store, feed } = setup();
    feed({ key: { remoteJid: MOM }, message: { conversation: 'did the code work?' }, messageTimestamp: NOW - 60 });
    feed({ key: { remoteJid: YOSSI }, message: { conversation: 'thursday?' }, messageTimestamp: NOW - 60 });
    feed({ key: { remoteJid: MOM, fromMe: true }, message: { conversation: 'yes, 3333' }, messageTimestamp: NOW - 30 });
    feed({ key: { remoteJid: MOM }, message: { conversation: 'great!' } });
    expect(store.unheard().map((m) => m.raw_text)).toEqual(['thursday?', 'great!']);
  });

  it('applies deletes and edits', () => {
    const { store, feed } = setup();
    feed({ key: { remoteJid: YOSSI, id: 'X' }, message: { conversation: 'tuesday' } });
    feed({ key: { remoteJid: YOSSI }, message: { protocolMessage: { type: 14, key: { id: 'X' }, editedMessage: { conversation: 'wednesday' } } } });
    expect(store.findMessage(YOSSI, 'X')!.raw_text).toBe('wednesday');
    feed({ key: { remoteJid: YOSSI }, message: { protocolMessage: { type: 0, key: { id: 'X' } } } });
    expect(store.findMessage(YOSSI, 'X')).toBeUndefined();
  });

  it('merges a LID chat into the phone JID once the mapping is known', () => {
    const { store, feed, ingest } = setup();
    feed({ key: { remoteJid: '777@lid' }, message: { conversation: 'hi from lid' } });
    ingest.mapLid('777@lid', YOSSI);
    expect(store.getChat('777@lid')).toBeUndefined();
    expect(store.unheardForChat(YOSSI)).toHaveLength(1);
    feed({ key: { remoteJid: '777@lid' }, message: { conversation: 'again' } });
    expect(store.unheardForChat(YOSSI)).toHaveLength(2);
  });

  it('keeps only two image descriptions per chat', () => {
    const { store, feed } = setup();
    for (let i = 0; i < 4; i++) feed({ key: { remoteJid: MOM }, message: { imageMessage: {} } });
    expect((store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'describe'").get() as { n: number }).n).toBe(2);
  });

  it('ignores messages older than 4 days', () => {
    const { feed } = setup();
    expect(feed({ key: { remoteJid: MOM }, message: { conversation: 'old' }, messageTimestamp: NOW - 5 * 86400 })).toBeNull();
  });
});

describe('jobs', () => {
  it('retries with backoff, then gives up', async () => {
    const store = makeStore();
    let t = NOW;
    store.enqueue('classify', 1, t, t);
    let calls = 0;
    const worker = new JobWorker(store, async () => { calls++; throw new Error('boom'); }, () => t);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await worker.tick();
      worker.stop();
      t += 3600;
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(store.db.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'failed' });
  });

  it('does not count deferrals as attempts', async () => {
    const store = makeStore();
    let t = NOW;
    store.enqueue('summarize', 'x', t, t);
    let calls = 0;
    const worker = new JobWorker(store, async () => (++calls <= 10 ? { deferSeconds: 30 } : Promise.reject(new Error('timeout'))), () => t);
    for (let i = 0; i < 11; i++) { await worker.tick(); worker.stop(); t += 60; }
    expect(store.db.prepare('SELECT status, attempts FROM jobs').get()).toEqual({ status: 'pending', attempts: 1 });
  });

  it('a deferred job yields to a newer pending one', async () => {
    const store = makeStore();
    store.enqueue('summarize', 'x', NOW, NOW);
    const worker = new JobWorker(store, async () => { store.enqueue('summarize', 'x', NOW + 90, NOW, true); return { deferSeconds: 30 }; }, () => NOW);
    await worker.tick();
    worker.stop();
    expect(store.db.prepare('SELECT status FROM jobs ORDER BY id').all()).toEqual([{ status: 'done' }, { status: 'pending' }]);
  });

  it('defers without failing', async () => {
    const store = makeStore();
    store.enqueue('summarize', 'x', NOW, NOW);
    const worker = new JobWorker(store, async () => ({ deferSeconds: 30 }), () => NOW);
    await worker.tick();
    worker.stop();
    expect(store.db.prepare('SELECT status, run_after FROM jobs').get()).toEqual({ status: 'pending', run_after: NOW + 30 });
  });
});

describe('purge', () => {
  it('deletes messages older than the cutoff and their summaries', () => {
    const store = makeStore();
    store.upsertChat({ jid: MOM }, NOW);
    store.insertMessage({ id: 'a', chat_jid: MOM, sender_jid: MOM, sender_name: null, from_me: 0, type: 'text', raw_text: 'old', media_ref: null, is_trivial: 0, quoted_id: null, mentions_me: 0, created_at: NOW - 100 });
    store.setSummary(MOM, 'old stuff', 1);
    expect(store.purgeBefore(NOW)).toBe(1);
    expect(store.getChat(MOM)!.summary).toBeNull();
  });
});
