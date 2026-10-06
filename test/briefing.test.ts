import { describe, expect, it } from 'vitest';
import { buildBriefing, countsSentence, gatherUnheard, itemPrompt } from '../src/briefing/build.ts';
import { renderMessages, trivialTag } from '../src/briefing/render.ts';
import type { MessageRow } from '../src/db/types.ts';
import { addMessage, CONFIG, DOVID_C, FAMILY, makeConfig, makeStore, MOM, seedPeople, YOSSI } from './helpers.ts';

function setup() {
  const store = makeStore();
  seedPeople(store);
  for (const jid of [MOM, YOSSI, DOVID_C]) store.upsertChat({ jid }, 0);
  makeConfig(store, CONFIG);
  return store;
}

describe('briefing order', () => {
  it('goes urgent → flagged → roll call, with counts', () => {
    const store = setup();
    addMessage(store, YOSSI, { raw_text: 'can I borrow your sefer?' });
    addMessage(store, MOM, { raw_text: 'call me when you can' });
    addMessage(store, DOVID_C, { raw_text: 'Abba is in the hospital, call now', is_urgent: 1 });
    addMessage(store, DOVID_C, { raw_text: 'also, mazel tov on the shiur' });
    addMessage(store, FAMILY, { raw_text: 'shabbat shalom' });
    store.setSummary(YOSSI, 'asking to borrow your sefer', 999);

    const { items, counts } = buildBriefing(gatherUnheard(store), store);
    expect(counts).toEqual({ urgent: 1, flagged: 1, others: 3 });
    expect(countsSentence(counts)).toBe('You have 1 urgent message, 1 flagged chat, and 3 others.');
    expect(items.map((i) => i.kind)).toEqual(['urgent', 'flagged', 'rollcall']);
    const rollcall = items[2]!;
    if (rollcall.kind !== 'rollcall') throw new Error();
    // Urgent-containing chat first, then most recent.
    expect(rollcall.entries.map((e) => e.jid)).toEqual([DOVID_C, FAMILY, YOSSI]);
    expect(rollcall.entries[2]!.line).toBe('1 message: asking to borrow your sefer');
    expect(itemPrompt(items[0]!)).toContain('Abba is in the hospital');
  });

  it('says so when nothing is new', () => {
    expect(countsSentence({ urgent: 0, flagged: 0, others: 0 })).toBe('You have no new messages.');
    expect(countsSentence({ urgent: 0, flagged: 0, others: 2 })).toBe('You have 2 chats with new messages.');
  });

  it('asks before reading long flagged chats', () => {
    const store = setup();
    const long = 'word '.repeat(90);
    addMessage(store, MOM, { raw_text: long });
    addMessage(store, MOM, { raw_text: long });
    const { items } = buildBriefing(gatherUnheard(store), store);
    expect(items[0]).toMatchObject({ kind: 'flagged', mode: 'ask' });
    expect(itemPrompt(items[0]!)).toMatch(/Read them all or summarize\?/);
  });

  it('summarizes first when a single flagged chat is a bit long', () => {
    const store = setup();
    addMessage(store, MOM, { raw_text: 'word '.repeat(100) });
    store.setSummary(MOM, 'a long story about the wedding', 999);
    const { items } = buildBriefing(gatherUnheard(store), store);
    expect(items[0]).toMatchObject({ mode: 'summary_then_read', summary: 'a long story about the wedding' });
  });

  it('puts trivia-only chats last', () => {
    const store = setup();
    addMessage(store, YOSSI, { type: 'reaction', raw_text: '👍', is_trivial: 1 });
    addMessage(store, DOVID_C, { raw_text: 'see you at 8' });
    const { items } = buildBriefing(gatherUnheard(store), store);
    if (items[0]!.kind !== 'rollcall') throw new Error();
    expect(items[0]!.entries.map((e) => e.line)).toEqual(['1 message: see you at 8', 'just a reaction']);
  });
});

describe('render', () => {
  const msg = (f: Partial<MessageRow>): MessageRow => ({
    rowid: 1, id: 'x', chat_jid: MOM, sender_jid: MOM, sender_name: null, from_me: 0, type: 'text', raw_text: null,
    transcript: null, media_desc: null, media_ref: null, is_urgent: 0, is_trivial: 0, quoted_id: null, mentions_me: 0,
    heard_at: null, created_at: 0, ...f,
  });

  it('describes two photos and counts the rest', () => {
    const photos = Array.from({ length: 5 }, (_, i) => msg({ type: 'image', media_desc: `photo ${i}` }));
    expect(renderMessages(photos, null).lines).toEqual(['a photo: photo 0', 'a photo: photo 1', 'and 3 more photos']);
  });

  it('renders media types', () => {
    expect(renderMessages([msg({ type: 'voice', transcript: 'call me' }), msg({ type: 'voice' }), msg({ type: 'document', media_desc: 'invoice.pdf' })], null).lines)
      .toEqual(['voice note: "call me"', 'a voice note, not yet transcribed', 'a PDF called invoice.pdf']);
  });

  it('collapses trivia into a tag', () => {
    expect(trivialTag([msg({ type: 'reaction' }), msg({ type: 'reaction' }), msg({ raw_text: '👍' })])).toBe('a couple of reactions and a thumbs-up');
  });
});
