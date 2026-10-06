import type { Store } from '../db/store.ts';
import type { MessageRow, Tier } from '../db/types.ts';
import { displayName } from '../config/names.ts';
import { senderNamer, summaryFresh } from '../ingest/summaries.ts';
import { messageContent, renderMessages, wordCount, WORDS_PER_SECOND } from './render.ts';

/** Above this a flagged chat gets a quick summary before the verbatim read (~30 s). */
export const LONG_CHAT_WORDS = 75;
/** Above this, all flagged content together is too long to read unasked (~1 min). */
export const FLAGGED_BUDGET_WORDS = 150;
/** Roll-call lines handed to the model per item. */
export const ROLLCALL_BATCH = 3;

export interface ChatGroup {
  jid: string;
  name: string;
  isGroup: boolean;
  tier: Tier;
  /** Unheard incoming messages, oldest first. */
  messages: MessageRow[];
  lastActivity: number;
  summary: string | null;
  summaryFresh: boolean;
}

/** Unheard messages grouped by chat (muted chats excluded). */
export function gatherUnheard(store: Store): ChatGroup[] {
  const byChat = new Map<string, MessageRow[]>();
  for (const m of store.unheard()) {
    const list = byChat.get(m.chat_jid) ?? [];
    list.push(m);
    byChat.set(m.chat_jid, list);
  }
  return [...byChat.entries()].map(([jid, messages]) => {
    const chat = store.getChat(jid)!;
    return {
      jid,
      name: displayName(store, jid, messages.find((m) => m.sender_name)?.sender_name),
      isGroup: !!chat.is_group,
      tier: chat.tier,
      messages,
      lastActivity: Math.max(...messages.map((m) => m.created_at)),
      summary: chat.summary,
      summaryFresh: summaryFresh(chat.summary_upto, messages.filter((m) => !m.is_trivial)),
    };
  });
}

export interface RollcallEntry {
  jid: string;
  name: string;
  count: number;
  line: string;
  messageIds: number[];
}

export type Item =
  | { kind: 'urgent'; jid: string; name: string; isGroup: boolean; lines: string[]; messageIds: number[] }
  | {
      kind: 'flagged'; jid: string; name: string; isGroup: boolean; count: number; lines: string[]; trivial: string;
      seconds: number; mode: 'read' | 'summary_then_read' | 'ask'; summary: string | null; messageIds: number[];
    }
  | { kind: 'rollcall'; entries: RollcallEntry[] };

export interface Counts {
  urgent: number;
  flagged: number;
  others: number;
}

const ids = (ms: MessageRow[]) => ms.map((m) => m.rowid);

/** Fallback one-liner when the summary isn't ready: the message itself if short. */
export function fallbackLine(real: MessageRow[]): string {
  const last = real.at(-1);
  if (!last) return '';
  const content = messageContent(last);
  const words = content.split(/\s+/);
  const short = words.length <= 15 ? content : `${words.slice(0, 12).join(' ')}…`;
  return real.length === 1 ? short : `the latest says: ${short}`;
}

function rollcallLine(g: ChatGroup, real: MessageRow[], trivial: string): string {
  const count = real.length;
  if (!count) return `just ${trivial}`;
  const summary = g.summaryFresh && g.summary ? g.summary : fallbackLine(real);
  return `${count} message${count === 1 ? '' : 's'}: ${summary}${trivial ? `, plus ${trivial}` : ''}`;
}

/**
 * The automatic briefing (SPEC §3.2): urgent messages, then flagged chats by
 * most recent activity, then the roll call (urgent-containing chats first, then
 * most recent; trivia-only chats last).
 */
export function buildBriefing(groups: ChatGroup[], store: Store): { items: Item[]; counts: Counts } {
  const items: Item[] = [];
  const recent = (a: ChatGroup, b: ChatGroup) => b.lastActivity - a.lastActivity;
  const sender = senderNamer(store);
  const rest = new Map<string, MessageRow[]>();

  // 1. Urgent, newest first.
  const urgentGroups = groups.filter((g) => g.messages.some((m) => m.is_urgent)).sort(recent);
  let urgentCount = 0;
  for (const g of urgentGroups) {
    const urgent = g.messages.filter((m) => m.is_urgent);
    const remaining = g.messages.filter((m) => !m.is_urgent);
    urgentCount += urgent.length;
    const r = renderMessages(urgent, g.isGroup ? sender : null);
    // A chat with nothing else to say is finished by its urgent item (trivia included).
    const done = !remaining.some((m) => !m.is_trivial);
    items.push({ kind: 'urgent', jid: g.jid, name: g.name, isGroup: g.isGroup, lines: r.lines, messageIds: ids(done ? g.messages : urgent) });
    if (!done) rest.set(g.jid, remaining);
  }
  const remainingOf = (g: ChatGroup) => (urgentGroups.includes(g) ? rest.get(g.jid) : g.messages);

  // 2. Flagged, verbatim.
  const flagged = groups.filter((g) => g.tier === 'flagged' && remainingOf(g)).sort(recent);
  const rendered = flagged.map((g) => {
    const msgs = remainingOf(g)!;
    const r = renderMessages(msgs, g.isGroup ? sender : null);
    return { g, msgs, r, words: wordCount(r.lines.join(' ')) };
  });
  const overBudget = rendered.reduce((n, x) => n + x.words, 0) > FLAGGED_BUDGET_WORDS;
  for (const { g, msgs, r, words } of rendered) {
    const mode = words <= LONG_CHAT_WORDS ? 'read' : overBudget ? 'ask' : 'summary_then_read';
    items.push({
      kind: 'flagged', jid: g.jid, name: g.name, isGroup: g.isGroup, count: r.count, lines: r.lines, trivial: r.trivial,
      seconds: Math.round(words / WORDS_PER_SECOND), mode,
      summary: g.summaryFresh ? g.summary : null, messageIds: ids(msgs),
    });
  }

  // 3. Roll call.
  const others = groups.filter((g) => g.tier !== 'flagged' && remainingOf(g));
  const entries = others.map((g) => {
    const msgs = remainingOf(g)!;
    const r = renderMessages(msgs, null);
    return {
      g,
      hasUrgent: urgentGroups.includes(g),
      entry: { jid: g.jid, name: g.name, count: r.count, line: rollcallLine(g, msgs.filter((m) => !m.is_trivial), r.trivial), messageIds: ids(msgs) },
    };
  }).sort((a, b) =>
    Number(b.entry.count > 0) - Number(a.entry.count > 0)
    || Number(b.hasUrgent) - Number(a.hasUrgent)
    || recent(a.g, b.g));
  for (let i = 0; i < entries.length; i += ROLLCALL_BATCH) {
    items.push({ kind: 'rollcall', entries: entries.slice(i, i + ROLLCALL_BATCH).map((e) => e.entry) });
  }

  return { items, counts: { urgent: urgentCount, flagged: flagged.length, others: others.length } };
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** "You have 1 urgent message, 3 flagged chats, and 12 others." */
export function countsSentence(c: Counts): string {
  const parts = [
    c.urgent && n(c.urgent, 'urgent message', 'urgent messages'),
    c.flagged && n(c.flagged, 'flagged chat', 'flagged chats'),
    c.others && (c.urgent || c.flagged ? `${c.others} other${c.others === 1 ? '' : 's'}` : n(c.others, 'chat with new messages', 'chats with new messages')),
  ].filter(Boolean) as string[];
  if (!parts.length) return 'You have no new messages.';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}` : parts[0];
  return `You have ${list}.`;
}

/** The text handed to the model for one item. */
export function itemPrompt(item: Item): string {
  const verbatim = (lines: string[]) => lines.map((l) => `  ${l}`).join('\n');
  switch (item.kind) {
    case 'urgent':
      return `URGENT, from ${item.name}${item.isGroup ? ' (group)' : ''}. Say it's from ${item.name}, then read these verbatim, in their original language, without translating:\n${verbatim(item.lines)}`;
    case 'flagged': {
      const head = `Flagged chat: ${item.name}${item.isGroup ? ' (group)' : ''}, ${item.count} message${item.count === 1 ? '' : 's'}.`;
      const tail = item.trivial ? `\nThen mention: plus ${item.trivial}.` : '';
      if (!item.count) return `Flagged chat: ${item.name}, just ${item.trivial}. Say so in one short sentence.`;
      if (item.mode === 'ask') {
        const mins = Math.max(1, Math.round(item.seconds / 60));
        return `${head} It's long, about ${mins} minute${mins === 1 ? '' : 's'} to read. Ask: "${item.name} has ${item.count} messages, about ${mins} minute${mins === 1 ? '' : 's'}. Read them all or summarize?" Then call read_chat or summarize_chat with chat "${item.name}" accordingly.`;
      }
      const intro = item.mode === 'summary_then_read' && item.summary
        ? `Give this quick summary first: "${item.summary}". Then read the messages verbatim.`
        : 'Read the messages verbatim.';
      return `${head} ${intro} Keep their original language; don't translate unless asked:\n${verbatim(item.lines)}${tail}`;
    }
    case 'rollcall':
      return `Roll call. For each chat, say the name, the count and the summary in one short sentence, in English:\n${item.entries.map((e) => `  ${e.name}, ${e.line}`).join('\n')}`;
  }
}

/** The words the model is expected to say out loud for an item. */
export function itemSpeakable(item: Item): string {
  if (item.kind === 'rollcall') return item.entries.map((e) => `${e.name}, ${e.line}`).join(' ');
  if (item.kind === 'flagged' && item.mode === 'ask') return `${item.name} has ${item.count} messages. Read them all or summarize?`;
  return [item.name, ...item.lines].join(' ');
}

export const itemChat = (item: Item) => (item.kind === 'rollcall' ? item.entries.at(-1)!.jid : item.jid);
export const itemMessageIds = (item: Item) => (item.kind === 'rollcall' ? item.entries.flatMap((e) => e.messageIds) : item.messageIds);
export const itemChatName = (item: Item) => (item.kind === 'rollcall' ? item.entries[0]!.name : item.name);
