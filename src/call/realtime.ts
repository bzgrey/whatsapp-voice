import type { CallSession, Output } from '../briefing/session.ts';
import type { Store } from '../db/store.ts';
import { errMsg, log } from '../log.ts';
import { tokenCost } from '../llm/prices.ts';
import { wordCount, WORDS_PER_SECOND } from '../briefing/render.ts';

/** A Realtime server event (only the fields we read). */
export interface RealtimeEvent {
  type: string;
  event?: string;
  transcript?: string;
  error?: unknown;
  response?: {
    status?: string;
    output?: { type: string; name?: string; call_id?: string; arguments?: string; content?: { transcript?: string }[] }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { audio_tokens?: number };
      output_token_details?: { audio_tokens?: number };
    };
  };
}

export interface CallIO {
  /** Send a client event on the sideband WebSocket. */
  send(event: object): void;
  /** End the phone call. */
  hangup(): Promise<void>;
  /** Run `fn` after `ms` (injectable for tests). */
  later(fn: () => void, ms: number): void;
}

/**
 * Bridges one OpenAI Realtime SIP call to a CallSession: tool calls, keypad
 * events, "finished speaking" confirmations, usage logging and hangup. The only
 * engine-specific code (SPEC §10.5).
 */
export class RealtimeCall {
  private responding = false;
  private cancelSent = false;
  private notes: string[] = [];
  private hangupPending = false;
  private hungUp = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private session: CallSession,
    private io: CallIO,
    private store: Store,
    private model: string,
    private debugTranscripts = false,
  ) {}

  /** The sideband socket is open: say the opening. */
  async start() {
    this.deliver(await this.session.opening());
  }

  /** Events are processed strictly in order, since tool calls are async. */
  onEvent(ev: RealtimeEvent) {
    this.queue = this.queue.then(() => this.handle(ev)).catch((err) => log.error(`call ${this.session.callId}: ${errMsg(err)}`));
    return this.queue;
  }

  /** The socket closed (hangup from either side, or a drop). */
  closed() {
    this.session.end();
  }

  private async handle(ev: RealtimeEvent) {
    switch (ev.type) {
      case 'response.created':
        this.responding = true;
        return;
      case 'response.done':
        return this.responseDone(ev);
      case 'input_audio_buffer.dtmf_event_received': {
        const out = await this.session.dtmf(String(ev.event ?? ''));
        if (out) this.deliver({ ...out, output: `Keypad: ${out.output}` }, true);
        return;
      }
      case 'conversation.item.input_audio_transcription.completed':
        if (this.debugTranscripts) log.info(`call ${this.session.callId} HEARD: ${ev.transcript?.trim()}`);
        return;
      case 'response.output_audio_transcript.done':
        if (this.debugTranscripts) log.info(`call ${this.session.callId} SAID: ${ev.transcript?.trim()}`);
        return;
      case 'error':
        log.warn(`call ${this.session.callId}: realtime error ${JSON.stringify(ev.error).slice(0, 300)}`);
        return;
    }
  }

  private async responseDone(ev: RealtimeEvent) {
    this.responding = false;
    this.cancelSent = false;
    const r = ev.response ?? {};
    this.logUsage(r.usage);
    const completed = r.status === 'completed';
    const calls = completed ? (r.output ?? []).filter((o) => o.type === 'function_call') : [];
    const spoke = (r.output ?? []).some((o) => o.type === 'message');

    // Spoken to the end (not cut off by the caller): what was handed out is now heard.
    if (completed && spoke) this.session.confirmSpoken();

    if (completed && spoke && this.hangupPending && !calls.length) {
      const words = (r.output ?? []).flatMap((o) => o.content ?? []).map((c) => wordCount(c.transcript ?? '')).reduce((a, b) => a + b, 0);
      // response.done arrives when generation ends; let the audio finish playing first.
      this.io.later(() => void this.hangup(), Math.max(2000, (words / WORDS_PER_SECOND) * 1000 + 1000));
      return;
    }

    let needResponse = false;
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch { /* model sent bad JSON; tool gets no args */ }
      const out = await this.session.tool(c.name ?? '', args);
      if (out.hangup) this.armHangup();
      this.io.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: out.output } });
      needResponse = true;
    }
    for (const note of this.notes.splice(0)) {
      this.io.send(noteItem(note));
      needResponse = true;
    }
    if (needResponse) this.createResponse();
  }

  /**
   * Give the model a server note. Keypad notes interrupt whatever it's saying;
   * others wait for the current response to end.
   */
  private deliver(out: Output, interrupt = false) {
    if (out.hangup) this.armHangup();
    if (this.responding) {
      this.notes.push(out.output);
      if (interrupt && !this.cancelSent) {
        this.cancelSent = true;
        this.io.send({ type: 'response.cancel' });
      }
      return;
    }
    this.io.send(noteItem(out.output));
    this.createResponse();
  }

  /** Hang up after the goodbye is spoken, or after 15 s whatever happens. */
  private armHangup() {
    if (this.hangupPending) return;
    this.hangupPending = true;
    this.io.later(() => void this.hangup(), 15_000);
  }

  private createResponse() {
    this.responding = true;
    this.io.send({ type: 'response.create' });
  }

  private async hangup() {
    if (this.hungUp) return;
    this.hungUp = true;
    try { await this.io.hangup(); } catch (err) { log.warn(`call ${this.session.callId}: hangup failed: ${errMsg(err)}`); }
    this.session.end();
  }

  private logUsage(u: NonNullable<RealtimeEvent['response']>['usage']) {
    if (!u) return;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const audioIn = u.input_token_details?.audio_tokens ?? 0;
    const audioOut = u.output_token_details?.audio_tokens ?? 0;
    this.store.logUsage({
      purpose: 'call', model: this.model, input_tokens: input, output_tokens: output,
      cost_usd: tokenCost(this.model, input, output, audioIn, audioOut),
    }, Math.floor(Date.now() / 1000));
  }
}

/** Server notes go in as bracketed user messages (what the phase 3 test proved works). */
const noteItem = (text: string) => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Server: ${text}]` }] },
});
