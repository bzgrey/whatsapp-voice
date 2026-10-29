import type { ConfigSync, TierAction } from '../config/sync.ts';
import type { Store } from '../db/store.ts';
import type { DraftRow, MessageRow, SpokenKind, SpokenPart } from '../db/types.ts';
import type { Tasks } from '../llm/tasks.ts';
import { RETENTION_SECONDS, STALE_SECONDS } from '../env.ts';
import { errMsg, log } from '../log.ts';
import { displayName, normalizeName } from '../config/names.ts';
import { normalizePhone } from '../config/phone.ts';
import { buildDirectory, resolveSpoken, resolveSpokenWithFallback, type Entry } from '../config/resolve.ts';
import { chatContext, narrationFor, refreshSummaryLine, senderNamer } from '../ingest/summaries.ts';
import { getWaStatus } from '../whatsapp/status.ts';
import {
  buildBriefing, countsSentence, gatherUnheard, sentences, itemChat, itemMessageIds, itemPrompt, itemScript, itemSpeakable, type Item,
} from './build.ts';
import { messageContent, renderMessages, sincePhrase } from './render.ts';

/** Sends WhatsApp messages. Only the keypad-1 path in CallSession calls it. */
export interface Sender {
  sendText(jid: string, text: string, quoted: MessageRow | null): Promise<void>;
}

export interface SessionDeps {
  store: Store;
  config: ConfigSync;
  tasks: Tasks | null;
  sender: Sender;
  now: () => number;
}

/** What the engine adapter passes back to the model. `hangup`: end the call once this is spoken. */
/**
 * Exact words the server wants spoken (a briefing part), and whether the
 * briefing then carries on by itself or waits for the caller.
 */
export interface Script {
  text: string;
  then: 'continue' | 'wait';
  /** For a part that waits: what the model should do once it has been said. */
  after?: string;
}

/** Something read out earlier that can be said again. */
interface Replay {
  text: string;
  /** Messages it covered (any still unheard count as heard once it's said). */
  ids: number[];
  jid: string | null;
}

export interface Output {
  output: string;
  /** Speak exactly this (the adapter forces it), instead of trusting the model to read `output`. */
  script?: Script;
  /** Leave this much silence after the previous part finishes playing before saying this one. */
  pauseMs?: number;
  hangup?: boolean;
}

type Step =
  | { kind: 'say'; text: string }
  | { kind: 'draft'; draft: DraftRow }
  | { kind: 'items' }
  | { kind: 'item'; item: Item };

const PIN_TRIES = 3;
const SUMMARY_TIMEOUT_MS = 8000;
/** Don't warn about a WhatsApp reconnect blip shorter than this. */
const WA_WARN_AFTER_SECONDS = 120;

/** Silence between urgent/flagged chats, and before the roll call. */
export const PAUSE_BETWEEN_CHATS_MS = 750;
export const PAUSE_BEFORE_ROLLCALL_MS = 1000;

const NEXT = 'When you have said all of it out loud, call next_item to continue the briefing.';
/** Share of a part's content words that must appear in what the model said. */
const SPOKEN_COVERAGE = 0.5;
/** For a part the server forces word for word: anything much less means it skipped some. */
const SCRIPTED_COVERAGE = 0.8;
/** After this many refusals for one part, let next_item through rather than loop. */
const MAX_REFUSALS = 2;

/** Distinctive words of a text (any script), for checking what was actually said. */
function contentWords(s: string): Set<string> {
  return new Set(normalizeName(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
}
const STOP = new Set(['the', 'and', 'you', 'your', 'are', 'for', 'with', 'that', 'this', 'has', 'have', 'message', 'messages', 'says', 'said', 'from', 'photo', 'plus']);
const coverage = (need: Set<string>, got: Set<string>) => {
  let hit = 0;
  for (const w of need) if (got.has(w)) hit++;
  return hit / need.size;
};

/**
 * One phone call: auth, the automatic briefing, free conversation, and the
 * keypad-gated send. Engine-agnostic: an adapter feeds it tool calls, keypad
 * digits and "the model finished speaking" signals, and speaks its outputs.
 */
export class CallSession {
  private state: 'pin' | 'active' | 'ended' = 'active';
  private steps: Step[] = [];
  private pos = 0;
  /** Handed to the model but not yet confirmed spoken; marked heard on confirmation. */
  private handed: number[] = [];
  /** Confirmed spoken, but the audio may still be playing: heard once it has (`at`, ms). */
  private playing: { ids: number[]; at: number }[] = [];
  /** The adapter's audio clock (ms): now, and when everything said so far finishes playing. */
  private nowMs = 0;
  private audioEndsAt = 0;
  private briefingDone = false;
  private endedByCaller = false;
  private closed = false;
  private pinDigits = '';
  private pinTries = 0;
  private summariesReady: Promise<unknown> = Promise.resolve();
  private summariesSettled = true;
  /**
   * The last thing handed out that the model must say out loud before the
   * briefing moves on, and how many of its words have been spoken so far.
   */
  private pending: { prompt: string; need: Set<string>; script: Script | null; about?: string } | null = null;
  /** The script for the output being built (taken by whoever returns it). */
  private script: Script | null = null;
  private spoken = new Set<string>();
  /** The briefing step behind the pending part, to put back if it's interrupted by a repeat or a read. */
  private pendingStep: Step | null = null;
  /** Steps already written to the spoken log (a put-back step isn't logged twice). */
  private logged = new WeakSet<Step>();
  private partNo = 0;
  /** Parts queued to be said again (repeat_briefing, keypad 3). */
  private replay: Replay[] = [];
  /** Consecutive "repeat that"s: each goes one part further back. Reset by anything new being read. */
  private repeatBack = 0;
  /** Times next_item was refused for the current part (we give up insisting after a couple). */
  private refusals = 0;
  private lastItemKind: Item['kind'] | null = null;
  private nextPause = 0;
  private activeDraft: DraftRow | null = null;
  /** Drafts written during this call; only these are replaced by a new draft_message. */
  private ownDrafts = new Set<number>();
  /** The chat just briefed or read, for "reply to that" and "read it". */
  private lastChat: string | null = null;
  readonly callId: number;

  constructor(private d: SessionDeps, readonly caller: string | null) {
    this.callId = d.store.startCall(caller, d.now());
    const myPhone = d.config.config.my_phone ? normalizePhone(d.config.config.my_phone) : null;
    const known = !!caller && !!myPhone && normalizePhone(caller) === myPhone;
    if (known) this.begin();
    else if (d.config.config.pin) this.state = 'pin';
    else this.state = 'ended';
    log.info(`call ${this.callId}: ${known ? 'known caller' : this.state === 'pin' ? 'PIN required' : 'unknown caller, no PIN set'}`);
  }

  get verified() { return this.state === 'active'; }

  /** What the model should do as soon as the call connects. */
  async opening(): Promise<Output> {
    if (this.state === 'pin') {
      return { output: 'The caller is not verified yet. Say only: "Please enter your PIN on the keypad." Reveal nothing else and call no tools until the PIN is accepted.' };
    }
    if (this.state === 'ended') return { output: 'Say only: "Sorry, this line is private." Then stop.', hangup: true };
    const output = `The call just connected. Start immediately with the following; no greeting.\n${await this.advance()}`;
    return { output, script: this.takeScript() };
  }

  // ---------- briefing ----------

  private begin() {
    const { store, now } = this.d;
    this.state = 'active';
    const t = now();
    store.markHeardBefore(t - STALE_SECONDS, t);
    const groups = gatherUnheard(store);
    const { counts } = buildBriefing(groups, store);

    // Pre-fill one-liners that weren't ready yet; awaited only when the items are reached.
    const tasks = this.d.tasks;
    if (tasks?.llm.available) {
      const stale = groups.filter((g) => !g.summaryFresh && g.messages.some((m) => !m.is_trivial));
      if (stale.length) {
        this.summariesSettled = false;
        this.summariesReady = Promise.allSettled(stale.map((g) => refreshSummaryLine(store, tasks, g.jid, t, SUMMARY_TIMEOUT_MS)))
          .then(() => { this.summariesSettled = true; });
      }
    }

    const wa = getWaStatus(store);
    if (wa && wa.state !== 'open' && t - wa.since > WA_WARN_AFTER_SECONDS) {
      this.steps.push({ kind: 'say', text: wa.state === 'logged_out'
        ? `Warning: WhatsApp has been logged out ${sincePhrase(wa.since, t)}. Someone needs to re-link it.`
        : `Warning: WhatsApp has been disconnected ${sincePhrase(wa.since, t)}.` });
    }
    // Offer every unsent draft, oldest first (normally zero or one).
    for (const draft of store.pendingDrafts().slice(0, 3).reverse()) this.steps.push({ kind: 'draft', draft });
    this.steps.push({ kind: 'say', text: countsSentence(counts) }, { kind: 'items' });
  }

  /**
   * The model finished a spoken response. Pass what it said (the transcript):
   * once enough of the pending part has been said, it counts as heard. With no
   * text (or force), confirms unconditionally.
   */
  confirmSpoken(said?: string, immediate = false) {
    if (said !== undefined && this.pending) {
      for (const w of contentWords(said)) this.spoken.add(w);
      if (coverage(this.pending.need, this.spoken) < (this.pending.script ? SCRIPTED_COVERAGE : SPOKEN_COVERAGE)) return;
    }
    this.pending = null;
    this.pendingStep = null;
    this.spoken.clear();
    this.refusals = 0;
    if (!this.handed.length) return;
    // The model writes ahead of the audio: only count it heard once it has had time to play.
    this.playing.push({ ids: this.handed, at: immediate ? 0 : this.audioEndsAt });
    this.handed = [];
    this.settle();
  }

  /** The caller cut a response off (spoke or pressed a key): repeating the part isn't the model refusing. */
  interrupted() {
    this.refusals = 0;
  }

  /** A forced part that carries on by itself is waiting to be said (it was cut off). What it's about, or null. */
  get resumable(): string | null {
    return this.pending?.script?.then === 'continue' ? this.pending.about ?? 'the briefing' : null;
  }

  /**
   * The adapter's audio clock (ms): the current time, and when what's been said
   * so far will have finished playing. Without one, heard marks are immediate.
   */
  setAudioClock(nowMs: number, audioEndsAt: number) {
    this.nowMs = nowMs;
    this.audioEndsAt = audioEndsAt;
    this.settle();
  }

  /** Mark heard whatever has finished playing. */
  private settle() {
    const done = this.playing.filter((p) => p.at <= this.nowMs);
    if (!done.length) return;
    this.playing = this.playing.filter((p) => p.at > this.nowMs);
    this.d.store.markHeard(done.flatMap((p) => p.ids), this.d.now());
  }

  /** The script for the output just built, if any (once). */
  private takeScript(): Script | undefined {
    const s = this.script;
    this.script = null;
    return s ?? undefined;
  }

  /** Remember what must be said out loud before moving on (judged by its content words). */
  private expect(prompt: string, speakable: string, script: Script | null = null) {
    const need = contentWords(speakable);
    this.script = script;
    this.pending = need.size ? { prompt, need, script } : null;
    this.pendingStep = null;
    this.spoken.clear();
    this.refusals = 0;
  }

  /**
   * Set aside the part being said (cut off before it was heard): its briefing step
   * goes back in the queue, and is skipped later if its messages get heard meanwhile.
   */
  private dropPending() {
    if (this.pendingStep) this.steps.splice(this.pos, 0, this.pendingStep);
    this.pendingStep = null;
    this.pending = null;
    this.handed = [];
    this.script = null;
    this.spoken.clear();
    this.refusals = 0;
  }

  /** Record what's being read out, so it can be repeated later in this call or on the next. */
  private logSpoken(kind: SpokenKind, parts: Replay[]) {
    if (!parts.length) return;
    this.partNo++;
    this.repeatBack = 0;
    this.d.store.logSpoken(parts.map((p) => ({
      call_id: this.callId, part: this.partNo, chat_jid: p.jid, kind, text: p.text, message_ids: p.ids,
    })), this.d.now());
  }

  private logItem(item: Item) {
    if (item.kind === 'rollcall') {
      this.logSpoken('rollcall', item.entries.map((e) => ({ jid: e.jid, text: `${e.name}, ${e.line}.`, ids: e.messageIds })));
    } else if (!(item.kind === 'flagged' && item.mode === 'ask')) {
      this.logSpoken(item.kind, [{ jid: item.jid, text: itemScript(item), ids: item.messageIds }]);
    }
  }

  /** Hand out the next queued repeat. */
  private nextReplay(): string {
    const r = this.replay.shift()!;
    this.hand([...this.d.store.stillUnheard(r.ids)], r.jid);
    const last = !this.replay.length;
    // After the last one, an unfinished briefing carries on by itself.
    const then = last && this.briefingDone ? 'wait' : 'continue';
    const prompt = `Say exactly: "${r.text}"${last ? '\nThat was a repeat.' : ''}`;
    this.expect(prompt, r.text, { text: r.text, then, after: 'That was a repeat. Wait for him.' });
    if (this.pending && r.jid) this.pending.about = displayName(this.d.store, r.jid);
    return prompt;
  }

  /** Parts said together (a roll-call batch) as one replay each, in order. */
  private replayGroups(parts: SpokenPart[]): Replay[] {
    const groups = new Map<number, Replay>();
    for (const p of parts) {
      const g = groups.get(p.part);
      if (g) { g.text += ` ${p.text}`; g.ids.push(...p.message_ids); } else groups.set(p.part, { text: p.text, ids: [...p.message_ids], jid: p.chat_jid });
    }
    return [...groups.values()];
  }

  /**
   * "Repeat that": the last part read on this call (the one cut off, if any),
   * and one further back each time he asks again. Null if this call has read nothing.
   */
  private repeatStep(): string | null {
    const groups = this.replayGroups(this.d.store.spokenParts(this.callId));
    if (!groups.length) return null;
    const i = groups.length - 1 - this.repeatBack;
    if (i < 0) {
      this.script = { text: 'That was the first one.', then: 'wait', after: 'Wait for him.' };
      return 'Say: "That was the first one."';
    }
    this.repeatBack++;
    this.dropPending();
    this.replay = [groups[i]!];
    return this.nextReplay();
  }

  private hand(ids: number[], chat: string | null) {
    this.handed.push(...ids);
    if (chat) this.lastChat = chat;
  }

  /**
   * Hand out the next chunk: any statements, then one item or question.
   * Refuses (repeating the pending part) if the model hasn't said the last one
   * out loud yet, unless the caller asked to skip.
   */
  private async advance(skip = false): Promise<string> {
    if (this.pending && !skip && this.refusals++ < MAX_REFUSALS) {
      this.script = this.pending.script;
      return `Not yet: you haven't said the previous part out loud. Say it to the caller now, then call next_item (or call next_item with skipped: true if they asked to skip it):\n${this.pending.prompt}`;
    }
    if (this.pending && !skip) {
      // It still wasn't said: move on, but it isn't heard. The next call includes it.
      log.warn(`call ${this.callId}: part not spoken after ${MAX_REFUSALS} retries; left unheard`);
      this.handed = [];
      this.pending = null;
      this.pendingStep = null;
    }
    this.confirmSpoken(undefined, skip);
    if (this.replay.length) return this.nextReplay();
    return this.nextChunk();
  }

  private async nextChunk(): Promise<string> {
    const { store } = this.d;
    const out: string[] = [];
    const said: string[] = [];
    // What must be heard is the item itself; the greeting before it doesn't count towards it.
    const done = (speakable: string, script?: Script) => {
      const prompt = out.join('\n');
      this.expect(prompt, speakable || said.join(' '), script ?? null);
      return prompt;
    };
    while (this.pos < this.steps.length) {
      const step = this.steps[this.pos++]!;
      if (step.kind === 'say') { out.push(`Say: "${step.text}"`); said.push(step.text); continue; }
      if (step.kind === 'items') {
        // If one-liners are still being written, let the greeting be spoken meanwhile rather than open with silence.
        if (out.length && !this.summariesSettled) {
          this.pos--;
          out.push('Say that out loud now. Then call next_item to begin the briefing.');
          return done('', { text: said.join(' '), then: 'continue' });
        }
        await this.summariesReady;
        const { items } = buildBriefing(gatherUnheard(store), store);
        this.steps.splice(this.pos, 0, ...items.map((item) => ({ kind: 'item' as const, item })));
        continue;
      }
      if (step.kind === 'draft') {
        if (store.getDraft(step.draft.id)?.status !== 'pending') continue;
        this.activeDraft = step.draft;
        const line = `You had an unsent message to ${displayName(store, step.draft.chat_jid)}: '${step.draft.text}'. Press 1 to send, or 9 to discard.`;
        const after = "Wait for the keypad. If they'd rather carry on, call next_item; the draft stays saved.";
        out.push(`Say: "${line}" ${after}`);
        return done(line, { text: [...said, line].join(' '), then: 'wait', after });
      }
      const item = this.stillRelevant(step.item);
      if (!item) continue;
      this.hand(itemMessageIds(item), itemChat(item));
      // A short silence between urgent/flagged chats and before the roll call (not within it).
      this.nextPause = this.lastItemKind === null ? 0
        : item.kind === 'rollcall' ? (this.lastItemKind === 'rollcall' ? 0 : PAUSE_BEFORE_ROLLCALL_MS)
        : PAUSE_BETWEEN_CHATS_MS;
      this.lastItemKind = item.kind;
      store.updateCall(this.callId, { current_chat: item.kind === 'rollcall' ? item.entries[0]!.jid : item.jid, in_briefing: true });
      if (!this.logged.has(step)) { this.logged.add(step); this.logItem(item); }
      out.push(itemPrompt(item));
      const ask = item.kind === 'flagged' && item.mode === 'ask';
      out.push(ask ? 'After reading or summarizing it, call next_item.' : NEXT);
      const after = ask
        ? `When he answers, call read_chat or summarize_chat with chat "${item.name}". After that, call next_item to carry on with the briefing.`
        : undefined;
      const prompt = done(itemSpeakable(item), { text: [...said, itemScript(item)].join(' '), then: ask ? 'wait' : 'continue', after });
      this.pendingStep = step;
      if (this.pending) this.pending.about = item.kind === 'rollcall' ? item.entries.map((e) => e.name).join(', ') : item.name;
      return prompt;
    }
    if (!this.briefingDone) {
      this.briefingDone = true;
      store.updateCall(this.callId, { current_chat: null, in_briefing: false });
      out.push('Briefing finished. Say only: "That\'s everything." Then wait silently for him to speak.');
      said.push("That's everything.");
    } else {
      out.push('The briefing is already finished. Say "That\'s everything." if you haven\'t, then wait for him.');
    }
    const prompt = out.join('\n');
    const script: Script | null = said.length ? { text: said.join(' '), then: 'wait', after: 'Wait silently for him to speak.' } : null;
    // Only statements (e.g. the greeting) still need saying before anything else is handed out.
    if (said.length) this.expect(prompt, said.join(' '), script);
    else { this.pending = null; this.script = null; }
    return prompt;
  }

  /** Drop parts of an item already heard (e.g. read on request earlier in the call). */
  private stillRelevant(item: Item): Item | null {
    const live = this.d.store.stillUnheard(itemMessageIds(item));
    if (item.kind === 'rollcall') {
      const entries = item.entries.filter((e) => e.messageIds.some((id) => live.has(id)));
      return entries.length ? { ...item, entries } : null;
    }
    return item.messageIds.some((id) => live.has(id)) ? item : null;
  }

  // ---------- tools ----------

  async tool(name: string, args: Record<string, any>): Promise<Output> {
    if (this.state === 'pin') return { output: 'Not verified. Ask the caller to enter their PIN on the keypad.' };
    if (this.state === 'ended') return { output: 'The call has ended.' };
    try {
      switch (name) {
        case 'next_item': {
          this.nextPause = 0;
          const output = await this.advance(!!args.skipped);
          return { output, pauseMs: this.nextPause || undefined, script: this.takeScript() };
        }
        case 'skip_briefing': return { output: this.skipBriefing() };
        case 'read_chat': { const output = await this.readChat(args.chat); return { output, script: this.takeScript() }; }
        case 'summarize_chat': { const output = await this.summarizeChat(args.chat); return { output, script: this.takeScript() }; }
        case 'repeat_briefing': {
          const output = await this.repeat(args.chat, !!args.whole, !!args.previous_call);
          return { output, script: this.takeScript() };
        }
        case 'search_recent': {
          const queries = [...(Array.isArray(args.queries) ? args.queries : []), ...(args.query ? [args.query] : [])].map(String);
          return { output: await this.searchRecent(args.chat, queries) };
        }
        case 'draft_message': return { output: await this.draftMessage(args.to, String(args.text ?? ''), !!args.reply_in_context) };
        case 'cancel_draft': return { output: this.cancelDraft() };
        case 'set_chat_tier': return { output: await this.setTier(args.chat, args.action) };
        case 'end_call':
          this.confirmSpoken();
          this.endedByCaller = true;
          return { output: 'Say a short goodbye.', hangup: true };
        default: return { output: `Unknown tool ${name}.` };
      }
    } catch (err) {
      log.error(`call ${this.callId}: tool ${name} failed: ${errMsg(err)}`);
      return { output: 'Something went wrong on the server. Apologize briefly and offer to try again.' };
    }
  }

  private skipBriefing(): string {
    this.confirmSpoken();
    this.replay = [];
    this.pos = this.steps.length;
    this.briefingDone = true;
    this.d.store.updateCall(this.callId, { current_chat: null, in_briefing: false });
    return 'Briefing skipped. Say "Okay." and wait for him.';
  }

  private async resolve(chat: string | undefined): Promise<{ entry?: Entry; ask?: string }> {
    const { store } = this.d;
    const dir = buildDirectory(store);
    if (!chat?.trim()) {
      const e = this.lastChat && dir.find((x) => x.jid === this.lastChat);
      return e ? { entry: e } : { ask: 'Ask which chat they mean.' };
    }
    const r = await resolveSpokenWithFallback(dir, chat, undefined, this.d.tasks?.llm.available ? this.d.tasks.matchNames : undefined);
    if (r.status === 'ok') return { entry: r.entry };
    if (r.status === 'unknown') return { ask: `No contact or group matches "${chat}". Say so and ask them to say the name again.` };
    // The chat just heard wins an ambiguity (SPEC §5.2).
    const ctx = r.matches.find((m) => m.jid === this.lastChat);
    if (ctx) return { entry: ctx };
    const opts = r.matches.slice(0, 3).map((m) => m.label + (m.lastActivity ? ` who messaged ${this.when(m.lastActivity)}` : ''));
    return { ask: `"${chat}" could be: ${opts.join('; or ')}. Ask which one, e.g. "${opts.slice(0, 2).join(', or ')}?" Then call again with the full name.` };
  }

  private when(ts: number): string {
    const days = Math.floor((this.d.now() - ts) / 86400);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  }

  private speakLines(msgs: MessageRow[]): string[] {
    return renderMessages(msgs, narrationFor(this.d.store, msgs)).lines;
  }


  private async readChat(chat: string | undefined): Promise<string> {
    const { entry, ask } = await this.resolve(chat);
    if (!entry) return ask!;
    const { store, now } = this.d;
    const unheard = store.unheardForChat(entry.jid);
    this.lastChat = entry.jid;
    const after = 'Wait for him.';
    if (!unheard.length) {
      const recent = store.recentForChat(entry.jid, now() - RETENTION_SECONDS, 8);
      if (!recent.length) return `There are no messages from ${entry.label} in the last 4 days. Say so.`;
      const lines = this.speakLines(recent);
      const text = `No new messages from ${entry.label}. The latest: ${sentences(lines)}`;
      this.dropPending();
      this.logSpoken('read', [{ jid: entry.jid, text, ids: recent.filter((m) => !m.from_me).map((m) => m.rowid) }]);
      this.script = { text, then: 'wait', after };
      return `No new messages from ${entry.label}. The most recent ones, oldest first; read these lines as written, the quoted text verbatim in its original language:\n${lines.map((l) => `  ${l}`).join('\n')}`;
    }
    const r = renderMessages(unheard, narrationFor(store, unheard));
    const ids = unheard.map((m) => m.rowid);
    const text = `${entry.label}, ${r.count} new message${r.count === 1 ? '' : 's'}. ${sentences(r.lines)}${r.trivial ? ` Plus ${r.trivial}.` : ''}`;
    this.dropPending();
    this.hand(ids, entry.jid);
    this.expect(`Read ${entry.label}'s messages to the caller.`, r.lines.join(' '), { text, then: 'wait', after });
    this.logSpoken('read', [{ jid: entry.jid, text, ids }]);
    return `${entry.label}, ${r.count} new message${r.count === 1 ? '' : 's'}. Read these lines as written; each names who sent it. Read the quoted text verbatim in its original language, without translating:\n${r.lines.map((l) => `  ${l}`).join('\n')}${r.trivial ? `\nThen mention: plus ${r.trivial}.` : ''}`;
  }

  private async summarizeChat(chat: string | undefined): Promise<string> {
    const { entry, ask } = await this.resolve(chat);
    if (!entry) return ask!;
    const { store, now, tasks } = this.d;
    this.lastChat = entry.jid;
    const lines = chatContext(store, entry.jid, now());
    if (!lines.length) return `There are no messages from ${entry.label} in the last 4 days. Say so.`;
    const unheard = store.unheardForChat(entry.jid);
    if (!tasks?.llm.available) return `Summarize this conversation with ${entry.label} for the caller in a few spoken sentences, focusing on lines marked (new):\n${lines.join('\n')}`;
    const summary = await tasks.summaryDetail(entry.label, entry.isGroup, lines);
    const ids = unheard.map((m) => m.rowid);
    this.dropPending();
    this.hand(ids, entry.jid);
    this.expect(`Give the caller this summary of ${entry.label}: ${summary}`, summary, { text: summary, then: 'wait', after: 'Wait for him.' });
    this.logSpoken('summary', [{ jid: entry.jid, text: summary, ids }]);
    return `Summary of ${entry.label}. Say this naturally:\n${summary}`;
  }

  private async searchRecent(chat: string | undefined, queries: string[]): Promise<string> {
    const { store, now } = this.d;
    const header = 'Messages from the last 4 days (nothing older exists). Answer the caller\'s question from these; if the answer isn\'t here, say so.';
    const terms = [...new Set(queries.map((q) => q.trim().toLowerCase()).filter(Boolean))];
    if (!chat?.trim()) {
      // "Did Eitan Moore text me?" arrives as a search for the name: look in his chat instead.
      const dir = buildDirectory(store);
      const named = terms.map((t) => resolveSpoken(dir, t)).find((r) => r.status === 'ok' && !r.weak);
      if (named?.status === 'ok') { chat = named.entry.names[0] ?? named.entry.label; terms.length = 0; }
    }
    if (chat?.trim()) {
      const { entry, ask } = await this.resolve(chat);
      if (!entry) return ask!;
      this.lastChat = entry.jid;
      const all = chatContext(store, entry.jid, now());
      const lines = all.filter((l) => !terms.length || terms.some((t) => l.toLowerCase().includes(t)));
      const shown = lines.length ? lines : all;
      return shown.length ? `${header}\nChat with ${entry.label}:\n${shown.join('\n')}` : `No messages with ${entry.label} in the last 4 days.`;
    }
    if (!terms.length) return 'Ask which chat or what to look for.';
    // Any of the spellings / languages given counts as a hit.
    const byId = new Map<number, MessageRow>();
    for (const t of terms) for (const m of store.search(t, now() - RETENTION_SECONDS)) byId.set(m.rowid, m);
    const hits = [...byId.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 40);
    if (!hits.length) return `Nothing in the last 4 days mentions ${terms.map((t) => `"${t}"`).join(' or ')}. Say so.`;
    const sender = senderNamer(store);
    return `${header}\n${hits.map((m) => `[${displayName(store, m.chat_jid)}] ${m.from_me ? 'Me' : sender(m)}: ${messageContent(m)}`).join('\n')}`;
  }

  /**
   * Say again what was read out: one chat's part, the whole briefing, or the last
   * part. Looks in this call first, then the most recent earlier call.
   */
  private async repeat(chat: string | undefined, whole: boolean, previousCall: boolean): Promise<string> {
    const { store } = this.d;
    if (!chat?.trim() && !whole && !previousCall) {
      const last = this.repeatStep();
      if (last) return `Repeating ${this.repeatBack > 1 ? 'the part before' : 'the last part'}.\n${last}`;
      // Nothing read on this call yet ("what was my last briefing?"): the whole previous call.
    }
    let jid: string | undefined;
    let label = 'the briefing';
    if (chat?.trim()) {
      const { entry, ask } = await this.resolve(chat);
      if (!entry) return ask!;
      jid = entry.jid;
      label = entry.label;
      this.lastChat = entry.jid;
    }
    let parts: SpokenPart[] = previousCall ? [] : store.spokenParts(this.callId, jid);
    let earlier = false;
    if (!parts.length) {
      const prev = store.previousSpokenCall(this.callId, jid);
      if (prev) { parts = store.spokenParts(prev, jid); earlier = true; }
    }
    if (!parts.length) {
      return jid
        ? `Nothing from ${label} was read out on this call or recent ones. Call read_chat with chat "${label}" to read their messages.`
        : 'Nothing has been read out yet, on this call or the last one. Say so.';
    }
    const replay = this.replayGroups(parts);
    if (earlier) replay[0]!.text = `From your last call: ${replay[0]!.text}`;
    this.dropPending();
    this.replay = replay;
    log.info(`call ${this.callId}: repeating ${replay.length} part${replay.length === 1 ? '' : 's'}${earlier ? ' from an earlier call' : ''}`);
    return `Repeating ${label}${earlier ? ' from the last call' : ''}.\n${this.nextReplay()}`;
  }

  private async draftMessage(to: string | undefined, text: string, inContext: boolean): Promise<string> {
    text = text.trim();
    if (!text) return 'The message text is empty. Ask what they want to say.';
    if (!to?.trim() && !inContext) return 'Ask who the message is for.';
    const { entry, ask } = await this.resolve(to);
    const { store, now } = this.d;
    if (!entry) {
      // He's dictating something new, so keypad 1 must not send the earlier draft. One from this call
      // is replaced (as a saved new draft would replace it); one offered from an earlier call stays saved for next time.
      if (this.activeDraft && this.ownDrafts.has(this.activeDraft.id)) store.setDraftStatus(this.activeDraft.id, 'cancelled', now());
      this.activeDraft = null;
      return `NO DRAFT SAVED: nothing will send yet. Don't read anything back or mention pressing 1. ${ask!}`;
    }
    const quoted = inContext && entry.jid === this.lastChat ? store.lastIncoming(entry.jid) ?? null : null;
    // A new draft replaces (corrects) one dictated in this call; a draft offered from an earlier call stays saved.
    if (this.activeDraft && this.ownDrafts.has(this.activeDraft.id)) store.setDraftStatus(this.activeDraft.id, 'cancelled', now());
    this.activeDraft = store.createDraft({ chat_jid: entry.jid, text, quoted_id: quoted?.id ?? null }, now());
    this.ownDrafts.add(this.activeDraft.id);
    this.lastChat = entry.jid;
    const name = entry.isGroup ? `the ${entry.label} group` : entry.label;
    return [
      `Draft saved${quoted ? ' as a reply to their last message' : ''}. Read it back exactly, then wait for the keypad:`,
      `"To ${name}: '${text}'. Press 1 to send."`,
      'Do NOT say it was sent: only keypad 1 sends. If they just say "yes", remind them to press 1. For a change, call draft_message again with the full corrected text.',
    ].join('\n');
  }

  private cancelDraft(): string {
    if (!this.activeDraft) return 'There is no draft to cancel. Say so.';
    this.d.store.setDraftStatus(this.activeDraft.id, 'cancelled', this.d.now());
    this.activeDraft = null;
    return 'Draft discarded. Say: "Cancelled."';
  }

  private async setTier(chat: string | undefined, action: TierAction): Promise<string> {
    if (!['flag', 'unflag', 'mute', 'unmute'].includes(action)) return 'Unknown action. Use flag, unflag, mute or unmute.';
    const { entry, ask } = await this.resolve(chat);
    if (!entry) return ask!;
    return `Say: "${this.d.config.applyVoice(entry, action)}"`;
  }

  // ---------- keypad ----------

  /** A keypad press. Returns what the model should say, or null to ignore. */
  async dtmf(digit: string): Promise<Output | null> {
    if (this.state === 'ended') return null;
    if (this.state === 'pin') return this.pinDigit(digit);
    switch (digit) {
      case '1': return { output: await this.send() };
      case '2':
        if (this.briefingDone) return { output: 'The caller pressed 2 (next), but the briefing is finished. Say so briefly.' };
        return { output: `The caller pressed 2: skip to the next chat. Stop the current one.\n${await this.advance(true)}`, script: this.takeScript() };
      case '3': {
        const last = this.repeatStep();
        return last
          ? { output: `The caller pressed 3: repeat.\n${last}`, script: this.takeScript() }
          : { output: 'The caller pressed 3: repeat the last thing you said, word for word.' };
      }
      case '9':
        return { output: this.activeDraft ? this.cancelDraft() : 'The caller pressed 9 (cancel), but nothing is pending. Ignore it unless they ask.' };
      case '#':
        return { output: `The caller pressed #. ${this.briefingDone ? 'The briefing is already finished; ignore it.' : this.skipBriefing()}` };
      default:
        return null;
    }
  }

  private async pinDigit(digit: string): Promise<Output | null> {
    const pin = this.d.config.config.pin;
    if (!/^\d$/.test(digit)) { this.pinDigits = ''; return null; }
    this.pinDigits += digit;
    if (this.pinDigits.length < pin.length) return null;
    const ok = this.pinDigits === pin;
    this.pinDigits = '';
    if (ok) {
      log.info(`call ${this.callId}: PIN accepted`);
      this.begin();
      const output = `PIN accepted.\n${await this.advance()}`;
      const script = this.takeScript();
      return { output, script: script && { ...script, text: `PIN accepted. ${script.text}` } };
    }
    this.pinTries++;
    log.warn(`call ${this.callId}: wrong PIN (${this.pinTries}/${PIN_TRIES})`);
    if (this.pinTries >= PIN_TRIES) {
      this.state = 'ended';
      return { output: 'Say only: "Wrong PIN. Goodbye."', hangup: true };
    }
    return { output: 'Say only: "Wrong PIN. Please try again."' };
  }

  /** The only path that sends a WhatsApp message (SPEC §5.4, §10.3). */
  private async send(): Promise<string> {
    const draft = this.activeDraft;
    if (!draft) {
      return 'The caller pressed 1, but no draft is ready to send. Say briefly that there\'s nothing to send. '
        + 'If they dictated a message that never got "Draft saved", call draft_message again with the recipient\'s full name.';
    }
    const { store, now, config, sender } = this.d;
    const cfg = config.config;
    const text = cfg.dictation_marker ? `${draft.text} ${cfg.dictation_marker_text}` : draft.text;
    const quoted = draft.quoted_id ? store.findMessage(draft.chat_jid, draft.quoted_id) ?? null : null;
    try {
      await sender.sendText(draft.chat_jid, text, quoted);
    } catch (err) {
      log.error(`call ${this.callId}: send failed: ${errMsg(err)}`);
      return 'Sending failed (WhatsApp may be disconnected). Say: "Sorry, it didn\'t send. The message is saved; try again later."';
    }
    store.setDraftStatus(draft.id, 'sent', now());
    this.activeDraft = null;
    log.info(`call ${this.callId}: sent a message to ${displayName(store, draft.chat_jid)}`);
    return 'Sent. Say: "Sent."';
  }

  // ---------- end ----------

  /** The call is over (hung up, or after end_call). Whatever wasn't heard stays unheard, so the next call's fresh briefing includes it. */
  end() {
    if (this.closed) return;
    this.closed = true;
    // Whatever was still playing when the line went dead wasn't heard.
    this.settle();
    this.playing = [];
    const dropped = this.state === 'active' && !this.endedByCaller && !this.briefingDone;
    this.d.store.endCall(this.callId, dropped ? 'dropped' : 'ended', this.d.now());
    this.state = 'ended';
    log.info(`call ${this.callId}: ${dropped ? 'dropped' : 'ended'}`);
  }
}
