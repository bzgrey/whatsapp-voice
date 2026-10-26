import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CallSession } from '../src/briefing/session.ts';
import { RealtimeCall, type RealtimeEvent } from '../src/call/realtime.ts';
import { verifySignature } from '../src/call/webhook.ts';
import { addMessage, CONFIG, FakeSender, makeConfig, makeStore, MOM, NOW, seedPeople, YOSSI } from './helpers.ts';

function setup(caller = '0535551234', seed: (store: ReturnType<typeof makeStore>) => void = () => {}) {
  const store = makeStore();
  seedPeople(store);
  for (const jid of [MOM, YOSSI]) store.upsertChat({ jid }, 0);
  seed(store);
  const config = makeConfig(store, CONFIG);
  const sender = new FakeSender();
  const session = new CallSession({ store, config, tasks: null, sender, now: () => NOW }, caller);
  const sent: any[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let hungUp = 0;
  let clock = 0;
  const call = new RealtimeCall(session, {
    send: (e) => sent.push(e),
    hangup: async () => { hungUp++; },
    later: (fn, ms) => timers.push({ fn, ms }),
    now: () => clock,
  }, store, 'gpt-realtime-2.1-mini');
  const notes = () => sent.filter((e) => e.item?.role === 'user').map((e) => e.item.content[0].text as string);
  const outputs = () => sent.filter((e) => e.item?.type === 'function_call_output').map((e) => e.item.output as string);
  const done = (output: NonNullable<RealtimeEvent['response']>['output'], status = 'completed') =>
    call.onEvent({ type: 'response.done', response: { status, output, usage: { input_tokens: 100, output_tokens: 50, input_token_details: { audio_tokens: 80 }, output_token_details: { audio_tokens: 40 } } } });
  const said = (transcript = 'ok') => ({ type: 'message', content: [{ transcript }] });
  /** response.create events that force the server's exact words. */
  const scripted = () => sent.filter((e) => e.type === 'response.create' && e.response?.instructions);
  /** A forced (scripted) response finishing, with what was actually said. */
  const spoke = (transcript: string, then = 'continue', status = 'completed') =>
    call.onEvent({ type: 'response.done', response: { status, metadata: { script: then }, output: [said(transcript)] } });
  const fn = (name: string, args = {}) => ({ type: 'function_call', name, call_id: `c_${name}`, arguments: JSON.stringify(args) });
  return { store, config, sender, session, call, sent, timers, notes, outputs, done, said, fn, scripted, spoke, hungUp: () => hungUp, wait: (ms: number) => (clock += ms) };
}

describe('realtime adapter', () => {
  it('has the server speak each part word for word, and counts it heard only once said and played', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'call me' }));
    await t.call.start();
    const first = t.scripted()[0]!.response;
    expect(first.instructions).toMatch(/1 flagged\..*call me/s);
    expect(first).toMatchObject({ tool_choice: 'none', metadata: { script: 'continue' } });

    // The first-call bug: the model chains next_item without speaking. Nothing is marked heard,
    // and the part is forced again.
    await t.call.onEvent({ type: 'response.created' });
    await t.done([t.fn('next_item')]);
    expect(t.store.unheard()).toHaveLength(1);
    expect(t.scripted()).toHaveLength(2);
    expect(t.scripted()[1]!.response.instructions).toContain('call me');

    await t.spoke('1 flagged. Mom wrote: call me', 'continue', 'cancelled'); // caller talked over it
    expect(t.store.unheard()).toHaveLength(1);
    expect(t.scripted()).toHaveLength(2); // no auto-advance after an interruption

    await t.spoke('1 flagged. Mom wrote: "call me"');
    expect(t.store.unheard()).toHaveLength(1); // said, but the audio is still playing
    // The server carried on by itself: the end of the briefing, which then waits.
    expect(t.scripted()[2]!.response).toMatchObject({ metadata: { script: 'wait' } });
    expect(t.scripted()[2]!.response.instructions).toContain("That's everything.");
    t.wait(10_000);
    await t.call.onEvent({ type: 'response.created' });
    expect(t.store.unheard()).toHaveLength(0);
    expect(t.store.usageSince(0)[0]).toMatchObject({ purpose: 'call', calls: 1, cost_usd: expect.any(Number) });
  });

  it('moves on without marking heard when the part never gets said', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'are you coming home for Sukkos' }));
    await t.call.start();
    for (let i = 0; i < 3; i++) await t.spoke('Okay, let me read those flagged messages carefully.');
    expect(t.scripted().at(-1)!.response.instructions).toContain("That's everything.");
    expect(t.store.unheard()).toHaveLength(1);
  });

  it('leaves a chat unheard if the line drops while its audio is still playing', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'call me' }));
    await t.call.start();
    await t.done([t.said('One flagged. Mom says: call me')]);
    t.wait(500); // the caller hangs up half a second into it
    t.call.closed();
    expect(t.store.unheard()).toHaveLength(1);
  });

  it('interrupts with keypad notes and delivers them after the cancelled response', async () => {
    const t = setup();
    await t.call.start();
    await t.call.onEvent({ type: 'response.created' });
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '9' });
    expect(t.sent.at(-1)).toEqual({ type: 'response.cancel' });
    const before = t.notes().length;
    await t.done([], 'cancelled');
    expect(t.notes().slice(before)).toContainEqual(expect.stringMatching(/Keypad 9: The caller pressed 9/));
    expect(t.sent.at(-1)).toEqual({ type: 'response.create' });
  });

  it('keypad 3 has the server say the cut-off part again, word for word', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'call me' }));
    await t.call.start();
    await t.call.onEvent({ type: 'response.created' });
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '3' });
    await t.done([], 'cancelled');
    expect(t.scripted()).toHaveLength(2);
    expect(t.scripted()[1]!.response.instructions).toContain('call me');
  });

  it('a part that waits for him gets its follow-up instructions only once it has ended', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'call me' }));
    await t.call.start();
    await t.spoke('1 flagged. Mom wrote: "call me"');
    // The server moved on by itself to "That's everything.", which waits: no note yet.
    expect(t.notes().join('\n')).not.toMatch(/Wait silently/);
    await t.spoke("That's everything.", 'wait');
    expect(t.notes().at(-1)).toMatch(/just read a part to him.*Next: Wait silently/s);
  });

  it('never puts a note just before a forced part, and gives it a context of its own', async () => {
    const t = setup(undefined, (s) => {
      addMessage(s, MOM, { raw_text: 'call me' });
      addMessage(s, YOSSI, { raw_text: 'sefer?' });
    });
    await t.call.start();
    await t.spoke('1 flagged, 1 other. Mom wrote: "call me"');
    t.timers.at(-1)?.fn();
    await t.spoke('Yossi Cohen, 1 message: sefer?');
    await t.call.onEvent({ type: 'response.created' });
    await t.done([t.fn('read_chat', { chat: 'Mom' })]);
    expect(t.scripted().length).toBeGreaterThanOrEqual(3);
    t.sent.forEach((e, i) => {
      if (e.type !== 'response.create' || !e.response?.instructions) return;
      expect(e.response).toMatchObject({ conversation: 'auto', input: [expect.objectContaining({ role: 'user' })] });
      expect(t.sent[i - 1]?.item?.role).not.toBe('user'); // nothing the model could read out
    });
    expect(t.outputs().at(-1)).toMatch(/reading this to him/);
  });

  it('holds a paused part back while he is talking, and says it after his turn', async () => {
    const t = setup(undefined, (s) => {
      addMessage(s, YOSSI, { raw_text: 'can I borrow the sefer' });
      addMessage(s, MOM, { raw_text: 'are you coming home for Sukkos' });
    });
    t.config.applyVoice({ jid: YOSSI, aliases: [], isGroup: false, names: ['Yossi Cohen'], label: 'Yossi Cohen', lastActivity: null }, 'flag');
    await t.call.start();
    await t.spoke('2 flagged. Mom wrote: are you coming home for Sukkos');
    const before = t.scripted().length;
    await t.call.onEvent({ type: 'input_audio_buffer.speech_started' });
    t.timers.at(-1)!.fn(); // the pause ends while he's talking
    expect(t.scripted().length).toBe(before); // not sent: OpenAI would refuse a second response
    await t.call.onEvent({ type: 'input_audio_buffer.speech_stopped' });
    await t.call.onEvent({ type: 'response.created' });
    await t.done([t.said('Sorry?')]);
    expect(t.scripted().at(-1)!.response.instructions).toContain('can I borrow the sefer');
  });

  it('being talked over does not use up the retries for a part', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'are you coming home for Sukkos' }));
    await t.call.start();
    for (let i = 0; i < 4; i++) {
      await t.spoke('1 flagged. Mom wrote', 'continue', 'cancelled');
      await t.done([t.fn('next_item')]); // he says "go on"
    }
    expect(t.scripted().at(-1)!.response.instructions).toContain('Sukkos');
    expect(t.scripted().at(-1)!.response.instructions).not.toContain("That's everything.");
  });

  it('sends only via keypad 1, then hangs up after the goodbye is spoken', async () => {
    const t = setup();
    await t.call.start();
    await t.done([t.said(), t.fn('draft_message', { to: 'Mom', text: 'home Thursday' })]);
    expect(t.sender.sent).toHaveLength(0);
    await t.done([t.said("To Mom: 'home Thursday'. Press 1 to send.")]);
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '1' });
    expect(t.sender.sent).toEqual([expect.objectContaining({ jid: MOM, text: 'home Thursday' })]);

    await t.done([t.fn('end_call')]);
    expect(t.timers.map((x) => x.ms)).toEqual([15_000]); // backstop
    await t.done([t.said('Goodbye, have a good day.')]);
    expect(t.timers).toHaveLength(2);
    t.timers[1]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(t.hungUp()).toBe(1);
    t.timers[0]!.fn(); // the backstop doesn't hang up twice
    await new Promise((r) => setImmediate(r));
    expect(t.hungUp()).toBe(1);
  });

  it('pauses between flagged chats and before the roll call, after the audio has played', async () => {
    const t = setup(undefined, (s) => {
      s.upsertChat({ jid: '972509999999@s.whatsapp.net' }, 0);
      addMessage(s, YOSSI, { raw_text: 'can I borrow the sefer' });
      addMessage(s, MOM, { raw_text: 'are you coming home for Sukkos' }); // newest flagged chat goes first
    });
    t.config.applyVoice({ jid: YOSSI, aliases: [], isGroup: false, names: ['Yossi Cohen'], label: 'Yossi Cohen', lastActivity: null }, 'flag');
    await t.call.start(); // counts + first flagged chat, no pause
    const said = 'One two three four five six seven eight nine ten'; // 10 words = 4 s of audio
    await t.spoke(`2 flagged. Mom wrote: are you coming home for Sukkos. ${said}`);
    const before = t.scripted().length;
    expect(t.timers.at(-1)!.ms).toBeGreaterThanOrEqual(750 + 4000);
    expect(t.scripted().length).toBe(before); // held back
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '3' }); // not lost while waiting
    t.timers.at(-1)!.fn();
    expect(t.scripted().at(-1)!.response.instructions).toContain('can I borrow the sefer');
    expect(t.notes().at(-1)).toMatch(/Keypad 3/);
  });

  it('hangs up after three wrong PINs', async () => {
    const t = setup('0529999999');
    await t.call.start();
    expect(t.notes()[0]).toMatch(/PIN/);
    await t.done([t.said()]);
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const d of '0000') await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: d });
      if (attempt < 2) await t.done([t.said('Wrong PIN. Please try again.')]);
    }
    expect(t.notes().at(-1)).toMatch(/Wrong PIN\. Goodbye/);
    await t.done([t.said('Wrong PIN. Goodbye.')]);
    t.timers.find((x) => x.ms !== 15_000)!.fn();
    await new Promise((r) => setImmediate(r));
    expect(t.hungUp()).toBe(1);
  });

  it('marks a mid-briefing hangup as dropped', async () => {
    const t = setup(undefined, (s) => addMessage(s, YOSSI, { raw_text: 'sefer?' }));
    await t.call.start();
    await t.done([t.said(), t.fn('next_item')]);
    t.call.closed();
    expect(t.store.db.prepare('SELECT status FROM calls').get()).toEqual({ status: 'dropped' });
  });
});

describe('webhook signature', () => {
  const secret = `whsec_${Buffer.from('test-secret-key').toString('base64')}`;
  const sign = (id: string, ts: string, body: string) =>
    `v1,${crypto.createHmac('sha256', Buffer.from('test-secret-key')).update(`${id}.${ts}.${body}`).digest('base64')}`;

  it('accepts a valid signature and rejects tampering or old timestamps', () => {
    const body = '{"type":"realtime.call.incoming"}';
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': '1000', 'webhook-signature': sign('msg_1', '1000', body) };
    expect(verifySignature(headers, body, secret, 1000)).toBe(true);
    expect(verifySignature(headers, body + ' ', secret, 1000)).toBe(false);
    expect(verifySignature(headers, body, secret, 2000)).toBe(false);
    expect(verifySignature({}, body, secret, 1000)).toBe(false);
  });
});
