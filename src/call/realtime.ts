import type { CallSession, Output, Script } from '../briefing/session.ts';
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
    metadata?: Record<string, string> | null;
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
  /** Current time in ms. */
  now(): number;
}

/**
 * Bridges one OpenAI Realtime SIP call to a CallSession: tool calls, keypad
 * events, "finished speaking" confirmations, usage logging and hangup. The only
 * engine-specific code (SPEC §10.5).
 */
export class RealtimeCall {
  private responding = false;
  private cancelSent = false;
  /** Queued for the next response: a note for the model, and/or a part to speak. */
  private notes: { text?: string; script?: Script }[] = [];
  /** The caller is talking (server VAD); a held-back part waits for his turn to finish. */
  private userSpeaking = false;
  private hangupPending = false;
  private hungUp = false;
  private queue: Promise<void> = Promise.resolve();
  /** Estimated time (ms since epoch) the audio generated so far finishes playing on the line. */
  private playoutUntil = 0;
  /** A paused next part is waiting to be handed over. */
  private waiting = false;

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
    this.syncClock();
    this.session.end();
  }

  /** Tell the session when the audio said so far finishes, so heard marks wait for it. */
  private syncClock() {
    this.session.setAudioClock(this.io.now(), this.playoutUntil);
  }

  private async handle(ev: RealtimeEvent) {
    this.syncClock();
    switch (ev.type) {
      case 'response.created':
        this.responding = true;
        return;
      case 'response.done':
        return this.responseDone(ev);
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        return;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        // Normally VAD now starts a response, and anything held back goes after it. If none starts, send it anyway.
        this.io.later(() => {
          if (!this.responding && !this.userSpeaking && !this.waiting && this.notes.length) this.flush([]);
        }, 1500);
        return;
      case 'input_audio_buffer.dtmf_event_received': {
        const digit = String(ev.event ?? '');
        const out = await this.session.dtmf(digit);
        if (out) this.deliver(out, true, `Keypad ${digit}`);
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
    if (r.status === 'cancelled') this.session.interrupted();
    /** A briefing part the server had spoken word for word; 'continue' means go straight on to the next. */
    const scripted = r.metadata?.script;
    const calls = completed ? (r.output ?? []).filter((o) => o.type === 'function_call') : [];
    const messages = (r.output ?? []).filter((o) => o.type === 'message');
    const spoke = messages.length > 0;
    const transcripts = messages.flatMap((o) => o.content ?? []).map((c) => c.transcript).filter((t): t is string => typeof t === 'string');

    // Generation runs ahead of playback; keep a running estimate of when the audio ends.
    const spokenMs = (wordCount(transcripts.join(' ')) / WORDS_PER_SECOND) * 1000;
    this.playoutUntil = Math.max(this.io.now(), this.playoutUntil) + spokenMs;
    this.syncClock();
    // Spoken to the end (not cut off by the caller): tell the session what was said,
    // so it counts as heard only once enough of the handed-out part was really spoken
    // (and, via the clock, only once its audio has had time to play).
    if (completed && spoke) this.session.confirmSpoken(transcripts.length ? transcripts.join(' ') : undefined);

    if (completed && spoke && this.hangupPending && !calls.length) {
      // response.done arrives when generation ends; let the audio finish playing first.
      this.io.later(() => void this.hangup(), Math.max(2000, spokenMs + 1000));
      return;
    }

    const outputs: object[] = [];
    let pauseMs = 0;
    let script: Script | undefined;
    if (completed && scripted === 'continue' && !calls.length) {
      // The server drives the briefing: once a part has been said, hand out the next one itself.
      const out = await this.session.tool('next_item', {});
      log.info(`call ${this.session.callId}: next part${out.output.startsWith('Not yet') ? ' (repeat: not spoken yet)' : ''}`);
      if (out.hangup) this.armHangup();
      // A part that carries on needs no note; one that waits for him brings its instructions for what comes after.
      return this.schedule([], out.script, out.pauseMs ?? 0, out.script?.then === 'continue' ? undefined : noteFor(out));
    }
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch { /* model sent bad JSON; tool gets no args */ }
      const out = await this.session.tool(c.name ?? '', args);
      // Metadata only: which tool, and whether the server held the briefing back.
      log.info(`call ${this.session.callId}: tool ${c.name}${out.output.startsWith('Not yet') ? ' (refused: not spoken yet)' : ''}`);
      if (out.hangup) this.armHangup();
      pauseMs = Math.max(pauseMs, out.pauseMs ?? 0);
      if (out.script) script = out.script;
      const output = noteFor(out);
      outputs.push({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output } });
    }
    this.schedule(outputs, script, pauseMs);
  }

  /** Send these (and any queued notes) and start the next response, after a pause if asked. */
  private schedule(outputs: object[], script: Script | undefined, pauseMs: number, note?: string) {
    if (note) this.notes.push({ text: note });
    if (pauseMs && (outputs.length || script)) {
      // Hold the next part until the current one has played, plus the pause.
      this.waiting = true;
      // Keypad notes that arrive meanwhile are newer than this part, so theirs wins.
      this.io.later(() => { this.waiting = false; this.flush(outputs, script, true); }, Math.max(0, this.playoutUntil - this.io.now()) + pauseMs);
      return;
    }
    this.flush(outputs, script);
  }

  /**
   * Send outputs and queued notes, then start a response. `notesWin`: a part
   * queued in the notes replaces `script` (it's newer); otherwise `script` wins.
   */
  private flush(outputs: object[], script?: Script, notesWin = false) {
    for (const o of outputs) this.io.send(o);
    if (this.responding || this.userSpeaking) {
      // He started talking during the pause: OpenAI would refuse a second response. Go after his turn.
      if (script) this.notes.push({ script });
      return;
    }
    const notes = this.notes.splice(0);
    let queued: Script | undefined;
    for (const note of notes) {
      if (note.text) this.io.send(noteItem(note.text));
      if (note.script) queued = note.script;
    }
    const next = notesWin ? queued ?? script : script ?? queued;
    if (outputs.length || notes.length || next) this.createResponse(next);
  }

  /**
   * Give the model a server note. Keypad notes interrupt whatever it's saying;
   * others wait for the current response to end.
   */
  private deliver(out: Output, interrupt = false, prefix?: string) {
    if (out.hangup) this.armHangup();
    const note = { text: `${prefix ? `${prefix}. ` : ''}${noteFor(out)}`, script: out.script };
    if (this.waiting) { this.notes.push(note); return; }
    if (this.responding) {
      this.notes.push(note);
      if (interrupt && !this.cancelSent) {
        this.cancelSent = true;
        this.io.send({ type: 'response.cancel' });
      }
      return;
    }
    this.io.send(noteItem(note.text));
    this.createResponse(out.script);
  }

  /** Hang up after the goodbye is spoken, or after 15 s whatever happens. */
  private armHangup() {
    if (this.hangupPending) return;
    this.hangupPending = true;
    this.io.later(() => void this.hangup(), 15_000);
  }

  /** Start a response; with a script, one that can only say those exact words. */
  private createResponse(script?: Script) {
    this.responding = true;
    this.io.send(script
      ? { type: 'response.create', response: { instructions: scriptInstructions(script.text), tool_choice: 'none', metadata: { script: script.then } } }
      : { type: 'response.create' });
  }

  private async hangup() {
    if (this.hungUp) return;
    this.hungUp = true;
    try { await this.io.hangup(); } catch (err) { log.warn(`call ${this.session.callId}: hangup failed: ${errMsg(err)}`); }
    this.syncClock();
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
/** What the model is told when the server speaks a briefing part through it. */
const SCRIPTED_NOTE = 'The server is reading the next part of the briefing to the caller and carries on by itself. '
  + "Don't call next_item for it. If he interrupts, answer him; call next_item only if he then wants the briefing to go on.";

/**
 * What the model is told about an output. The note goes in just before the
 * forced response, so it speaks of the part as about to be said.
 */
const noteFor = (out: Output) => !out.script ? out.output
  : out.script.then === 'continue' ? SCRIPTED_NOTE
  : `The server is now saying the next part to the caller through you, word for word. Once it has been said, don't say it again. Then: ${out.script.after ?? 'wait for him.'}`;

/** Per-response instructions that make the model voice the server's exact words. */
export const scriptInstructions = (text: string) => `You are reading WhatsApp messages aloud on a phone call. Say exactly the text below, word for word, and nothing else: no introduction, no comment, no question or offer afterwards. Read quoted text in its original language (Hebrew, Yiddish, English…) without translating. Speak clearly, with a short pause between messages.

${text}`;

const noteItem = (text: string) => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Server: ${text}]` }] },
});
