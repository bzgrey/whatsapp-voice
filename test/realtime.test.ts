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
  const call = new RealtimeCall(session, {
    send: (e) => sent.push(e),
    hangup: async () => { hungUp++; },
    later: (fn, ms) => timers.push({ fn, ms }),
    now: () => 0,
  }, store, 'gpt-realtime-2.1-mini');
  const notes = () => sent.filter((e) => e.item?.role === 'user').map((e) => e.item.content[0].text as string);
  const outputs = () => sent.filter((e) => e.item?.type === 'function_call_output').map((e) => e.item.output as string);
  const done = (output: NonNullable<RealtimeEvent['response']>['output'], status = 'completed') =>
    call.onEvent({ type: 'response.done', response: { status, output, usage: { input_tokens: 100, output_tokens: 50, input_token_details: { audio_tokens: 80 }, output_token_details: { audio_tokens: 40 } } } });
  const said = (transcript = 'ok') => ({ type: 'message', content: [{ transcript }] });
  const fn = (name: string, args = {}) => ({ type: 'function_call', name, call_id: `c_${name}`, arguments: JSON.stringify(args) });
  return { store, config, sender, session, call, sent, timers, notes, outputs, done, said, fn, hungUp: () => hungUp };
}

describe('realtime adapter', () => {
  it('speaks the opening, runs tool calls, and confirms heard only on a completed spoken response', async () => {
    const t = setup(undefined, (s) => addMessage(s, MOM, { raw_text: 'call me' }));
    await t.call.start();
    expect(t.notes()[0]).toMatch(/1 flagged/);
    expect(t.sent.at(-1)).toEqual({ type: 'response.create' });

    expect(t.notes()[0]).toContain('call me');

    // The first-call bug: the model chains next_item without speaking. Nothing is marked heard.
    await t.call.onEvent({ type: 'response.created' });
    await t.done([t.fn('next_item')]);
    expect(t.outputs()[0]).toMatch(/^Not yet/);
    expect(t.store.unheard()).toHaveLength(1);

    await t.done([t.said('You have one flagged chat. Mom says: call me')], 'cancelled'); // caller talked over it
    expect(t.store.unheard()).toHaveLength(1);
    await t.done([t.said('You have one flagged chat. Mom says: call me')]);
    expect(t.store.unheard()).toHaveLength(0);
    expect(t.store.usageSince(0)[0]).toMatchObject({ purpose: 'call', calls: 3, cost_usd: expect.any(Number) });
  });

  it('interrupts with keypad notes and delivers them after the cancelled response', async () => {
    const t = setup();
    await t.call.start();
    await t.call.onEvent({ type: 'response.created' });
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '3' });
    expect(t.sent.at(-1)).toEqual({ type: 'response.cancel' });
    const before = t.notes().length;
    await t.done([], 'cancelled');
    expect(t.notes().slice(before)).toEqual([expect.stringMatching(/Keypad: The caller pressed 3/)]);
    expect(t.sent.at(-1)).toEqual({ type: 'response.create' });
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
    await t.done([t.said(`Mom: are you coming home for Sukkos. ${said}`), t.fn('next_item')]);
    const sentBefore = t.outputs().length;
    expect(t.timers.at(-1)!.ms).toBeGreaterThanOrEqual(750 + 4000);
    expect(t.outputs().length).toBe(sentBefore); // held back
    await t.call.onEvent({ type: 'input_audio_buffer.dtmf_event_received', event: '3' }); // not lost while waiting
    t.timers.at(-1)!.fn();
    expect(t.outputs().at(-1)).toContain('can I borrow the sefer');
    expect(t.notes().at(-1)).toMatch(/pressed 3/);
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
