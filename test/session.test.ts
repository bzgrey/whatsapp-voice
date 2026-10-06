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

  it('stops insisting after two refusals rather than looping', async () => {
    const { store, call } = setup();
    addMessage(store, MOM, { raw_text: 'שלום, מתי אתה בא הביתה?' });
    const s = call();
    await s.opening();
    s.confirmSpoken('Mom asks when you are coming home.'); // translated instead of verbatim
    expect((await s.tool('next_item', {})).output).toMatch(/^Not yet/);
    expect((await s.tool('next_item', {})).output).toMatch(/^Not yet/);
    expect((await s.tool('next_item', {})).output).toMatch(/Briefing finished/);
  });

  it('offers to resume after a drop, and skips what was heard', async () => {
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
    expect(open).toMatch(/Your last call dropped during Yossi Cohen\. Resume\?/);
    s2.confirmSpoken();
    const next = (await s2.tool('next_item', {})).output;
    expect(next).toContain('1 chat.');
    expect(next).toContain('Yossi');
    expect(next).not.toContain('call me');
  });

  it('does not offer resume after a normal goodbye', async () => {
    const { store, call } = setup();
    addMessage(store, YOSSI, { raw_text: 'sefer?' });
    const s1 = call();
    await s1.opening();
    await s1.tool('end_call', {});
    s1.end();
    expect((await call().opening()).output).not.toMatch(/dropped/);
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
