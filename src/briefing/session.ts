import type { ConfigSync, TierAction } from '../config/sync.ts';
import type { Store } from '../db/store.ts';
import type { DraftRow, MessageRow } from '../db/types.ts';
import type { Tasks } from '../llm/tasks.ts';
import { RETENTION_SECONDS } from '../env.ts';
import { errMsg, log } from '../log.ts';
import { displayName, normalizeName } from '../config/names.ts';
import { normalizePhone } from '../config/phone.ts';
import { buildDirectory, resolveSpokenWithFallback, type Entry } from '../config/resolve.ts';
import { chatContext, refreshSummaryLine, senderNamer } from '../ingest/summaries.ts';
import { getWaStatus } from '../whatsapp/status.ts';
import {
  buildBriefing, countsSentence, gatherUnheard, itemChat, itemMessageIds, itemPrompt, itemSpeakable, type Item,
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
export interface Output {
  output: string;
  hangup?: boolean;
}

type Step =
  | { kind: 'say'; text: string }
  | { kind: 'resume'; name: string }
  | { kind: 'draft'; draft: DraftRow }
  | { kind: 'items' }
  | { kind: 'item'; item: Item };

const PIN_TRIES = 3;
const SUMMARY_TIMEOUT_MS = 8000;
/** Don't warn about a WhatsApp reconnect blip shorter than this. */
const WA_WARN_AFTER_SECONDS = 120;

const NEXT = 'When you have said all of it out loud, call next_item to continue the briefing.';
/** Share of a part's content words that must appear in what the model said. */
const SPOKEN_COVERAGE = 0.5;
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
  private pending: { prompt: string; need: Set<string> } | null = null;
  private spoken = new Set<string>();
  /** Times next_item was refused for the current part (we give up insisting after a couple). */
  private refusals = 0;
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
    return { output: `The call just connected. ${await this.advance()}` };
  }

  // ---------- briefing ----------

  private begin() {
    const { store, now } = this.d;
    this.state = 'active';
    const t = now();
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
    const prev = store.previousCall(this.callId);
    if (prev?.status === 'dropped' && prev.in_briefing && prev.current_chat
      && t - prev.started_at < RETENTION_SECONDS && store.unheardForChat(prev.current_chat).length) {
      this.steps.push({ kind: 'resume', name: displayName(store, prev.current_chat) });
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
  confirmSpoken(said?: string) {
    if (said !== undefined && this.pending) {
      for (const w of contentWords(said)) this.spoken.add(w);
      if (coverage(this.pending.need, this.spoken) < SPOKEN_COVERAGE) return;
    }
    this.pending = null;
    this.spoken.clear();
    this.refusals = 0;
    if (!this.handed.length) return;
    this.d.store.markHeard(this.handed, this.d.now());
    this.handed = [];
  }

  /** Remember what must be said out loud before moving on (judged by its content words). */
  private expect(prompt: string, speakable: string) {
    const need = contentWords(speakable);
    this.pending = need.size ? { prompt, need } : null;
    this.spoken.clear();
    this.refusals = 0;
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
      return `Not yet: you haven't said the previous part out loud. Say it to the caller now, then call next_item (or call next_item with skipped: true if they asked to skip it):\n${this.pending.prompt}`;
    }
    this.confirmSpoken();
    const out = await this.nextChunk();
    return out;
  }

  private async nextChunk(): Promise<string> {
    const { store } = this.d;
    const out: string[] = [];
    const said: string[] = [];
    // What must be heard is the item itself; the greeting before it doesn't count towards it.
    const done = (speakable: string) => {
      const prompt = out.join('\n');
      this.expect(prompt, speakable || said.join(' '));
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
          return done('');
        }
        await this.summariesReady;
        const { items } = buildBriefing(gatherUnheard(store), store);
        this.steps.splice(this.pos, 0, ...items.map((item) => ({ kind: 'item' as const, item })));
        continue;
      }
      if (step.kind === 'resume') {
        const q = `Your last call dropped during ${step.name}. Resume?`;
        out.push(`Ask: "${q}" If yes, call next_item. If no, call skip_briefing and ask what they'd like to do.`);
        return done(q);
      }
      if (step.kind === 'draft') {
        if (store.getDraft(step.draft.id)?.status !== 'pending') continue;
        this.activeDraft = step.draft;
        const line = `You had an unsent message to ${displayName(store, step.draft.chat_jid)}: '${step.draft.text}'. Press 1 to send, or 9 to discard.`;
        out.push(`Say: "${line}" Wait for the keypad. If they'd rather carry on, call next_item; the draft stays saved.`);
        return done(line);
      }
      const item = this.stillRelevant(step.item);
      if (!item) continue;
      this.hand(itemMessageIds(item), itemChat(item));
      store.updateCall(this.callId, { current_chat: item.kind === 'rollcall' ? item.entries[0]!.jid : item.jid, in_briefing: true });
      out.push(itemPrompt(item));
      out.push(item.kind === 'flagged' && item.mode === 'ask' ? 'After reading or summarizing it, call next_item.' : NEXT);
      return done(itemSpeakable(item));
    }
    if (!this.briefingDone) {
      this.briefingDone = true;
      store.updateCall(this.callId, { current_chat: null, in_briefing: false });
      out.push('Briefing finished. Say "That\'s everything new." and ask if they want anything else: more about a chat, a reply, or something from the last few days.');
      said.push("That's everything new.");
    } else {
      out.push('The briefing is already finished. Ask what they would like to do.');
    }
    const prompt = out.join('\n');
    // Only statements (e.g. the greeting) still need saying before anything else is handed out.
    if (said.length) this.expect(prompt, said.join(' '));
    else this.pending = null;
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
        case 'next_item': return { output: await this.advance(!!args.skipped) };
        case 'skip_briefing': return { output: this.skipBriefing() };
        case 'read_chat': return { output: await this.readChat(args.chat) };
        case 'summarize_chat': return { output: await this.summarizeChat(args.chat) };
        case 'search_recent': return { output: await this.searchRecent(args.chat, args.query) };
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
    this.pos = this.steps.length;
    this.briefingDone = true;
    this.d.store.updateCall(this.callId, { current_chat: null, in_briefing: false });
    return 'Briefing skipped. Ask what they would like to do.';
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

  private speakLines(msgs: MessageRow[], isGroup: boolean): string[] {
    const sender = senderNamer(this.d.store);
    return msgs.map((m) => `${m.from_me ? 'You' : isGroup ? sender(m) : 'They'}: ${messageContent(m)}`);
  }

  private async readChat(chat: string | undefined): Promise<string> {
    const { entry, ask } = await this.resolve(chat);
    if (!entry) return ask!;
    const { store, now } = this.d;
    const unheard = store.unheardForChat(entry.jid);
    this.lastChat = entry.jid;
    if (!unheard.length) {
      const recent = store.recentForChat(entry.jid, now() - RETENTION_SECONDS, 8);
      if (!recent.length) return `There are no messages from ${entry.label} in the last 4 days. Say so.`;
      return `No new messages from ${entry.label}. The most recent ones, oldest first; read them verbatim in their original language:\n${this.speakLines(recent, entry.isGroup).map((l) => `  ${l}`).join('\n')}`;
    }
    const r = renderMessages(unheard, entry.isGroup ? senderNamer(store) : null);
    this.hand(unheard.map((m) => m.rowid), entry.jid);
    this.expect(`Read ${entry.label}'s messages to the caller.`, r.lines.join(' '));
    return `${entry.label}, ${r.count} new message${r.count === 1 ? '' : 's'}. Read them verbatim, in their original language, without translating:\n${r.lines.map((l) => `  ${l}`).join('\n')}${r.trivial ? `\nThen mention: plus ${r.trivial}.` : ''}`;
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
    this.hand(unheard.map((m) => m.rowid), entry.jid);
    this.expect(`Give the caller this summary of ${entry.label}: ${summary}`, summary);
    return `Summary of ${entry.label}. Say this naturally:\n${summary}`;
  }

  private async searchRecent(chat: string | undefined, query: string | undefined): Promise<string> {
    const { store, now } = this.d;
    const header = 'Messages from the last 4 days (nothing older exists). Answer the caller\'s question from these; if the answer isn\'t here, say so.';
    if (chat?.trim()) {
      const { entry, ask } = await this.resolve(chat);
      if (!entry) return ask!;
      this.lastChat = entry.jid;
      const lines = chatContext(store, entry.jid, now()).filter((l) => !query || l.toLowerCase().includes(query.toLowerCase()));
      const all = lines.length ? lines : chatContext(store, entry.jid, now());
      return all.length ? `${header}\nChat with ${entry.label}:\n${all.join('\n')}` : `No messages with ${entry.label} in the last 4 days.`;
    }
    if (!query?.trim()) return 'Ask which chat or what to look for.';
    const hits = store.search(query.trim(), now() - RETENTION_SECONDS);
    if (!hits.length) return `Nothing in the last 4 days mentions "${query}". Say so.`;
    const sender = senderNamer(store);
    return `${header}\n${hits.map((m) => `[${displayName(store, m.chat_jid)}] ${m.from_me ? 'Me' : sender(m)}: ${messageContent(m)}`).join('\n')}`;
  }

  private async draftMessage(to: string | undefined, text: string, inContext: boolean): Promise<string> {
    text = text.trim();
    if (!text) return 'The message text is empty. Ask what they want to say.';
    if (!to?.trim() && !inContext) return 'Ask who the message is for.';
    const { entry, ask } = await this.resolve(to);
    if (!entry) return ask!;
    const { store, now } = this.d;
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
        return { output: `The caller pressed 2: skip to the next chat. Stop the current one.\n${await this.advance(true)}` };
      case '3': return { output: 'The caller pressed 3: repeat the last thing you said, word for word.' };
      case '9':
        return { output: this.activeDraft ? this.cancelDraft() : 'The caller pressed 9 (cancel), but nothing is pending. Ignore it unless they ask.' };
      case '#':
        return { output: `The caller pressed #. ${this.briefingDone ? 'The briefing is already finished. Ask what they would like to do.' : this.skipBriefing()}` };
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
      return { output: `PIN accepted.\n${await this.advance()}` };
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
    if (!draft) return 'The caller pressed 1, but there is nothing to send. Say so briefly.';
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

  /** The call is over (hung up, or after end_call). A drop mid-briefing is offered for resume next time. */
  end() {
    if (this.closed) return;
    this.closed = true;
    const dropped = this.state === 'active' && !this.endedByCaller && !this.briefingDone;
    this.d.store.endCall(this.callId, dropped ? 'dropped' : 'ended', this.d.now());
    this.state = 'ended';
    log.info(`call ${this.callId}: ${dropped ? 'dropped' : 'ended'}`);
  }
}
