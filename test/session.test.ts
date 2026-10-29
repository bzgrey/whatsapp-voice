import { describe, expect, it } from 'vitest';
import { CallSession } from '../src/briefing/session.ts';
import { setWaStatus } from '../src/whatsapp/status.ts';
import { addMessage, CONFIG, FakeSender, makeConfig, makeStore, MOM, NOW, seedPeople, YOSSI, DOVID_C, DOVID_L } from './helpers.ts';

function setup() {
  const store = makeStore();
  seedPeople(store);
  for (const jid of [MOM, YOSSI, DOVID_C, DOVID_L]) store.upsertChat({ jid }, 0);
  const config = makeConfig(store, CONFIG);
  const sender = new FakeSender();
  let t = NOW;
  const deps = { store, config, tasks: null, sender, now: () => t };
  const call = (caller = '0535551234') => new CallSession(deps, caller);
  return { store, config, sender, call, tick: (s: number) => (t += s) };
}

describe('auth', () => {
  it('lets my number straight in', async () => {
    const { call } = setup();
    const s = call('+972-53-555-1234');
    expect(s.verified).toBe(true);
    expect((await s.opening()).output).toContain('No new messages.');
  });

  it('treats messages older than 2 days as already seen', async () => {
    const { store, call } = setup();
    addMessage(store, YOSSI, { raw_text: 'old news', created_at: NOW - 3 * 86400 });
    addMessage(store, MOM, { raw_text: 'call me', created_at: NOW - 3600 });
    expect((await call('+972-53-555-1234').opening()).output).toContain('1 flagged.');
    expect(store.unheard().map((m) => m.raw_text)).toEqual(['call me']);
  });

  it('still briefs an urgent message older than 2 days, and drops one-liners over stale messages', () => {
    const { store } = setup();
    addMessage(store, YOSSI, { raw_text: 'old news', created_at: NOW - 3 * 86400 });
    addMessage(store, MOM, { raw_text: 'hospital, call', created_at: NOW - 3 * 86400, is_urgent: 1 });
    store.setSummary(YOSSI, 'old news', 999999);
    expect(store.markHeardBefore(NOW - 2 * 86400, NOW)).toEqual([YOSSI]);
    expect(store.unheard().map((m) => m.raw_text)).toEqual(['hospital, call']);
    expect(store.getChat(YOSSI)!.summary).toBeNull();
  });

  it('asks other callers for the PIN and hangs up after 3 wrong tries', async () => {
    const { call } = setup();
    const s = call('0529999999');
    expect((await s.opening()).output).toMatch(/PIN/);
    expect((await s.tool('next_item', {})).output).toMatch(/Not verified/);
    for (const d of '432') expect(await s.dtmf(d)).toBeNull();
    expect((await s.dtmf('0'))!.output).toMatch(/Wrong PIN/);
    for (const d of '1111') await s.dtmf(d);
    const last = await (async () => { let r; for (const d of '2222') r = await s.dtmf(d); return r; })();
    expect(last).toMatchObject({ hangup: true });
  });

  it('accepts the right PIN and starts the briefing', async () => {
    const { call } = setup();
    const s = call(null as unknown as string);
    for (const d of '432') await s.dtmf(d);
    const r = await s.dtmf('1');
    expect(r!.output).toMatch(/PIN accepted/);
    expect(s.verified).toBe(true);
  });
});

describe('briefing flow', () => {
  it('opens with the greeting and first item, and marks it heard only once it was said', async () => {
    const { store, call } = setup();
    addMessage(store, MOM, { raw_text: 'call me when you get a chance today' });
    addMessage(store, YOSSI, { raw_text: 'sefer?' });
    const s = call();
    const open = (await s.opening()).output;
    expect(open).toContain('1 flagged, 1 other.');
    expect(open).toContain('call me when you get a chance today');
    s.confirmSpoken('Okay.'); // too little to count
    expect(store.unheard()).toHaveLength(2);
    s.confirmSpoken('You have one flagged chat and one other. Mom says: call me when you get a chance today.');
    expect(store.unheard().map((m) => m.chat_jid)).toEqual([YOSSI]);
    expect((await s.tool('next_item', {})).output).toContain('Roll call');
    s.confirmSpoken('Yossi Cohen, one message: sefer?');
    expect(store.unheard()).toHaveLength(0);
    expect((await s.tool('next_item', {})).output).toMatch(/Briefing finished/);
  });

  it('refuses to move on when the model asks for the next part without speaking (the first-call bug)', async () => {
    const { store, call } = setup();
    addMessage(store, MOM, { raw_text: 'a photo of the sukkah' });
    addMessage(store, YOSSI, { raw_text: 'sefer?' });
    const s = call();
    await s.opening();
    for (let i = 0; i < 2; i++) {
      const r = (await s.tool('next_item', {})).output;
      expect(r).toMatch(/^Not yet: you haven't said the previous part out loud/);
      expect(r).toContain('a photo of the sukkah');
    }
    expect(store.unheard()).toHaveLength(2);
    // The caller says "skip": that's allowed, and counts as heard (it was mentioned).
    expect((await s.tool('next_item', { skipped: true })).output).toContain('Roll call');
    expect(store.unheard().map((m) => m.chat_jid)).toEqual([YOSSI]);
    // Keypad 2 also moves on.
    expect((await s.dtmf('2'))!.output).toMatch(/Briefing finished/);
    expect(store.unheard()).toHaveLength(0);
  });

  it('does not count the greeting as having read the flagged chat (the third-call bug)', async () => {
    const { store, call } = setup();
    addMessage(store, MOM, { type: 'image', media_desc: 'the new sukkah decorations', raw_text: null });
    addMessage(store, MOM, { raw_text: 'are you coming home for Sukkos?' });
    addMessage(store, YOSSI, { raw_text: 'sefer?' });
    const s = call();
    await s.opening();
    s.confirmSpoken('You have one flagged chat and one other chat with new messages.');
    expect(store.unheard()).toHaveLength(3);
    expect((await s.tool('next_item', {})).output).toMatch(/^Not yet/);
    s.confirmSpoken('Mom sent a photo of the new sukkah decorations, and asks: are you coming home for Sukkos?');
    expect(store.unheard().map((m) => m.chat_jid)).toEqual([YOSSI]);
    expect((await s.tool('next_item', {})).output).toContain('Roll call');
  });

  it('stops insisting after two refusals rather than looping, leaving the part unheard', async () => {
    const { store, call } = setup();
    addMessage(store, MOM, { raw_text: 'שלום, מתי אתה בא הביתה?' });
    const s = call();
    await s.opening();
    s.confirmSpoken('Mom asks when you are coming home.'); // translated instead of verbatim
    expect((await s.tool('next_item', {})).output).toMatch(/^Not yet/);
    expect((await s.tool('next_item', {})).output).toMatch(/^Not yet/);
    expect((await s.tool('next_item', {})).output).toMatch(/Briefing finished/);
    expect(store.unheard()).toHaveLength(1); // the next call reads it
  });

  it('starts fresh after a drop, with whatever was not heard', async () => {
    const { store, call, tick } = setup();
    addMessage(store, MOM, { raw_text: 'call me' });
    addMessage(store, YOSSI, { raw_text: 'sefer?' });
    const s1 = call();
    await s1.opening(); // greeting + Mom
    s1.confirmSpoken(); // Mom was read
    await s1.tool('next_item', {}); // Yossi handed out, then the line drops before it's said
    s1.end();
    tick(60);
    const s2 = call();
    const open = (await s2.opening()).output;
    expect(open).not.toMatch(/dropped|Resume/);
    expect(open).toContain('1 chat.');
    expect(open).toContain('Yossi');
    expect(open).not.toContain('call me');
  });

  it('skips the rest with #, and warns when WhatsApp is down', async () => {
    const { store, call, tick } = setup();
    setWaStatus(store, 'closed', NOW);
    tick(3 * 3600);
    addMessage(store, MOM, { raw_text: 'call me' });
    const s = call();
    expect((await s.opening()).output).toMatch(/WhatsApp has been disconnected for about 3 hours/);
    expect((await s.dtmf('#'))!.output).toMatch(/skipped/);
    expect((await s.dtmf('2'))!.output).toMatch(/finished/);
  });
});

describe('sending', () => {
  it('only sends on keypad 1, as a quote-reply in context', async () => {
    const { store, call, sender } = setup();
    addMessage(store, YOSSI, { id: 'Q', raw_text: 'sefer?' });
    const s = call();
    await s.opening();
    await s.tool('next_item', {}); // Yossi's roll call is the current chat
    const draft = (await s.tool('draft_message', { text: 'Sure, take it', reply_in_context: true })).output;
    expect(draft).toContain(`"To Yossi Cohen: 'Sure, take it'. Press 1 to send."`);
    expect(draft).toMatch(/reply to their last message/);
    expect(sender.sent).toHaveLength(0);
    expect((await s.dtmf('1'))!.output).toMatch(/Sent/);
    expect(sender.sent).toEqual([{ jid: YOSSI, text: 'Sure, take it', quoted: expect.objectContaining({ id: 'Q' }) }]);
    expect((await s.dtmf('1'))!.output).toMatch(/nothing to send/);
  });

  it('says plainly when a draft was not saved, so the model never offers keypad 1', async () => {
    const { call, sender } = setup();
    const s = call();
    await s.opening();
    expect((await s.tool('draft_message', { to: 'Dovid', text: 'hi' })).output).toMatch(/^NO DRAFT SAVED.*could be/);
    expect((await s.dtmf('1'))!.output).toMatch(/nothing to send/);
    expect(sender.sent).toHaveLength(0);
  });

  it('a new draft whose name fails disarms the earlier one, so 1 sends nothing', async () => {
    const { store, call, sender } = setup();
    const s = call();
    await s.opening();
    await s.tool('draft_message', { to: 'Mom', text: 'running late' });
    expect((await s.tool('draft_message', { to: 'Dovid', text: "I'll be there at 8" })).output).toMatch(/^NO DRAFT SAVED/);
    expect((await s.dtmf('1'))!.output).toMatch(/nothing to send/);
    expect(sender.sent).toHaveLength(0);
    expect(store.pendingDrafts()).toHaveLength(0);
  });

  it('asks about ambiguous names unless context decides', async () => {
    const { store, call } = setup();
    const s = call();
    await s.opening();
    expect((await s.tool('draft_message', { to: 'Dovid', text: 'hi' })).output).toMatch(/Dovid Cohen.*or.*Dovid Levi/);
    addMessage(store, DOVID_L, { raw_text: 'hello' });
    await s.tool('read_chat', { chat: 'Dovid Levi' });
    expect((await s.tool('draft_message', { to: 'Dovid', text: 'hi' })).output).toContain('To Dovid Levi');
  });

  it('keeps an unconfirmed draft for the next call, and 9 discards it', async () => {
    const { store, call, sender } = setup();
    const s1 = call();
    await s1.opening();
    await s1.tool('draft_message', { to: 'Mom', text: "I'll be home Thursday night" });
    s1.end();
    const s2 = call();
    expect((await s2.opening()).output).toContain("You had an unsent message to Mom: 'I'll be home Thursday night'");
    expect((await s2.dtmf('9'))!.output).toMatch(/Cancelled/);
    expect(store.pendingDrafts()).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
  });

  it('a new draft does not discard a draft kept from an earlier call', async () => {
    const { store, call } = setup();
    const s1 = call();
    await s1.opening();
    await s1.tool('draft_message', { to: 'Mom', text: 'home Thursday' });
    await s1.tool('draft_message', { to: 'Mom', text: 'home Friday' }); // a correction replaces it
    s1.end();
    expect(store.pendingDrafts().map((d) => d.text)).toEqual(['home Friday']);
    const s2 = call();
    expect((await s2.opening()).output).toContain('home Friday');
    await s2.tool('next_item', {}); // "carry on"
    await s2.tool('draft_message', { to: 'Yossi', text: 'yes take it' });
    expect(store.pendingDrafts().map((d) => d.text).sort()).toEqual(['home Friday', 'yes take it']);
  });

  it('keeps the draft if sending fails', async () => {
    const { store, call, sender } = setup();
    sender.fail = true;
    const s = call();
    await s.opening();
    await s.tool('draft_message', { to: 'Mom', text: 'hi' });
    expect((await s.dtmf('1'))!.output).toMatch(/didn't send/);
    expect(store.pendingDrafts()).toHaveLength(1);
  });
});

describe('voice config', () => {
  it('flags and mutes by voice', async () => {
    const { store, call } = setup();
    const s = call();
    await s.opening();
    expect((await s.tool('set_chat_tier', { chat: 'Yossi', action: 'flag' })).output).toMatch(/flagged/);
    expect(store.getChat(YOSSI)!.tier).toBe('flagged');
  });
});

describe('repeating what was read', () => {
  /** A call that reads Mom (flagged) and Yossi (roll call), all said. */
  async function briefed(t: ReturnType<typeof setup>) {
    addMessage(t.store, MOM, { raw_text: 'are you coming home for Sukkos' });
    addMessage(t.store, YOSSI, { raw_text: 'can I borrow the sefer' });
    const s = t.call();
    await s.opening();
    s.confirmSpoken();
    await s.tool('next_item', {});
    s.confirmSpoken();
    await s.tool('next_item', {}); // That's everything.
    s.confirmSpoken();
    return s;
  }

  it("repeats one chat's part word for word, later in the same call", async () => {
    const t = setup();
    const s = await briefed(t);
    const r = await s.tool('repeat_briefing', { chat: 'Mom' });
    expect(r.script).toMatchObject({ then: 'wait' });
    expect(r.script!.text).toContain('are you coming home for Sukkos');
    expect(r.script!.text).not.toContain('sefer');
  });

  it('repeats the whole briefing in order, one part at a time', async () => {
    const t = setup();
    const s = await briefed(t);
    const first = await s.tool('repeat_briefing', { whole: true });
    expect(first.script).toMatchObject({ then: 'continue' });
    expect(first.script!.text).toContain('Sukkos');
    s.confirmSpoken();
    const second = await s.tool('next_item', {});
    expect(second.script!.text).toMatch(/Yossi Cohen, 1 message: .*sefer/);
    expect(second.script!.then).toBe('wait'); // the briefing was already finished
  });

  it("remembers the last call's briefing on the next call", async () => {
    const t = setup();
    const s1 = await briefed(t);
    s1.end();
    t.tick(3600);
    const s2 = t.call();
    expect((await s2.opening()).output).toContain('No new messages.');
    s2.confirmSpoken();
    const r = await s2.tool('repeat_briefing', { chat: 'Yossi' });
    expect(r.script!.text).toMatch(/^From your last call: Yossi Cohen, 1 message/);
    const all = await s2.tool('repeat_briefing', { previous_call: true, whole: true });
    expect(all.script!.text).toMatch(/^From your last call: .*Sukkos/);
  });

  it('repeats a part that was cut off, and keeps it unheard until it is said', async () => {
    const t = setup();
    addMessage(t.store, MOM, { raw_text: 'are you coming home for Sukkos' });
    const s = t.call();
    await s.opening(); // Mom handed out, then line noise cuts it off
    const r = await s.tool('repeat_briefing', {});
    expect(r.script!.text).toContain('Sukkos');
    expect(t.store.unheard()).toHaveLength(1);
    s.confirmSpoken('2 flagged. Mom wrote: are you coming home for Sukkos');
    expect(t.store.unheard()).toHaveLength(0);
  });

  it('a repeat mid-briefing puts the cut-off part back, then carries on', async () => {
    const t = setup();
    addMessage(t.store, MOM, { raw_text: 'are you coming home for Sukkos' });
    addMessage(t.store, YOSSI, { raw_text: 'can I borrow the sefer' });
    const s1 = t.call();
    await s1.opening(); s1.confirmSpoken(); await s1.tool('next_item', {}); s1.confirmSpoken(); s1.end();
    addMessage(t.store, DOVID_C, { raw_text: 'shiur moved to nine' });
    const s2 = t.call();
    await s2.opening(); // Dovid's roll call handed out, cut off by "what did Mom say last time?"
    const r = await s2.tool('repeat_briefing', { chat: 'Mom' });
    expect(r.script!.text).toContain('Sukkos');
    expect(r.script!.then).toBe('continue');
    s2.confirmSpoken();
    const next = await s2.tool('next_item', {});
    expect(next.script!.text).toContain('shiur moved to nine');
    expect(t.store.unheard()).toHaveLength(1); // not yet said
  });

  it('keypad 3 says the last chat again (not "That\'s everything."), and one further back each press', async () => {
    const t = setup();
    const s = await briefed(t);
    const r = await s.dtmf('3');
    expect(r!.script!.text).toMatch(/^Yossi Cohen, 1 message/);
    s.confirmSpoken();
    expect((await s.dtmf('3'))!.script!.text).toContain('Sukkos'); // "before that"
    s.confirmSpoken();
    expect((await s.dtmf('3'))!.script!.text).toBe('That was the first one.');
  });

  it('a repeat with nothing read yet on this call gives the whole previous briefing', async () => {
    const t = setup();
    (await briefed(t)).end();
    const s2 = t.call();
    await s2.opening();
    s2.confirmSpoken(); // "No new messages. That's everything."
    const r = await s2.tool('repeat_briefing', {});
    expect(r.script!.text).toMatch(/^From your last call: .*Sukkos/);
    s2.confirmSpoken();
    expect((await s2.tool('next_item', {})).script!.text).toMatch(/Yossi Cohen/);
  });

  it('a roll-call chat only half read is not marked heard', async () => {
    const t = setup();
    addMessage(t.store, YOSSI, { raw_text: 'x' });
    addMessage(t.store, DOVID_C, { raw_text: 'y' });
    t.store.setSummary(YOSSI, 'answering your Shabbat invitation question: they would be happy to host you', 999999);
    t.store.setSummary(DOVID_C, 'answering whether he will be at the wedding: accompanying Nakbali, arriving right at the start', 999999);
    const s = t.call();
    const open = await s.opening();
    expect(open.script!.text).not.toMatch(/Yossi.*Dovid|Dovid.*Yossi/s); // one chat per part
    s.confirmSpoken('Dovid Cohen, one message: answering whether he will be at the wedding');
    expect(t.store.unheardForChat(DOVID_C)).toHaveLength(1); // the rest of the line was skipped
    s.confirmSpoken('accompanying Nakbali, arriving right at the start');
    expect(t.store.unheardForChat(DOVID_C)).toHaveLength(0);
    expect(t.store.unheardForChat(YOSSI)).toHaveLength(1);
  });

  it('says so when there is nothing to repeat, and points to read_chat for a chat never read', async () => {
    const t = setup();
    const s = t.call();
    await s.opening();
    s.confirmSpoken();
    expect((await s.tool('repeat_briefing', { whole: true })).output).toMatch(/Nothing has been read out yet/);
    expect((await s.tool('repeat_briefing', { chat: 'Yossi' })).output).toMatch(/Call read_chat/);
  });

  it('forgets the text once its messages are purged or deleted', async () => {
    const t = setup();
    const s = await briefed(t);
    const mom = t.store.unheardForChat(MOM)[0] ?? t.store.recentForChat(MOM, 0)[0]!;
    t.store.deleteMessage(MOM, mom.id);
    expect(t.store.spokenParts(s.callId, MOM)).toHaveLength(0);
    t.store.purgeBefore(NOW + 10 * 86400);
    expect(t.store.spokenParts(s.callId)).toHaveLength(0);
  });
});

describe('search', () => {
  it('treats a search for a name as a look at that chat, heard or not', async () => {
    const t = setup();
    addMessage(t.store, YOSSI, { raw_text: 'can I borrow the sefer', heard_at: NOW - 60 } as any);
    const s = t.call();
    await s.opening();
    const r = await s.tool('search_recent', { queries: ['Yossi Cohen', 'יוסי כהן'] });
    expect(r.output).toContain('Chat with Yossi Cohen');
    expect(r.output).toContain('can I borrow the sefer');
  });

  it('matches any of the words given, so Hebrew and English both work', async () => {
    const t = setup();
    addMessage(t.store, YOSSI, { raw_text: 'החתונה ביום חמישי' });
    const s = t.call();
    await s.opening();
    const r = await s.tool('search_recent', { queries: ['wedding', 'חתונה'] });
    expect(r.output).toContain('החתונה');
  });
});
