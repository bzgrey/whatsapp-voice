import type { Store } from '../db/store.ts';
import type { MessageRow } from '../db/types.ts';
import { RETENTION_SECONDS } from '../env.ts';
import { displayName } from '../config/names.ts';
import { contextLines, messageContent, type Narration } from '../briefing/render.ts';
import type { Tasks } from '../llm/tasks.ts';

/** How many messages of earlier context go with the new ones. */
const CONTEXT_MESSAGES = 40;

export const senderNamer = (store: Store) => (m: MessageRow) =>
  m.from_me ? 'Me' : m.sender_jid ? displayName(store, m.sender_jid, m.sender_name) : (m.sender_name ?? 'someone');

const shortQuote = (m: MessageRow) => {
  const words = messageContent(m).replace(/^"|"$/g, '').split(/\s+/);
  return `"${words.slice(0, 10).join(' ')}${words.length > 10 ? '…' : ''}"`;
};

/**
 * How to introduce a chat's messages when read aloud: who sent each one, what
 * it replies to, and (for the first) the message of mine it follows.
 */
export function narrationFor(store: Store, msgs: MessageRow[]): Narration {
  const sender = senderNamer(store);
  const describe = (q: MessageRow) => `${q.from_me ? 'your message' : `${sender(q)}'s message`} ${shortQuote(q)}`;
  const first = msgs[0];
  const prev = first ? store.messageBefore(first.chat_jid, first.rowid, first.created_at) : undefined;
  return {
    senderOf: (m) => (m.from_me ? 'You' : sender(m)),
    replyOf: (m) => {
      if (!m.quoted_id || m.type === 'reaction') return null;
      const q = store.findMessage(m.chat_jid, m.quoted_id);
      return q ? describe(q) : null;
    },
    // Only when they're answering me: my message came last, within the last day.
    after: prev?.from_me && first && first.created_at - prev.created_at < 86400 ? describe(prev) : null,
  };
}

/** The chat's recent conversation as model context, with unheard lines marked (new). */
export function chatContext(store: Store, jid: string, now: number): string[] {
  return contextLines(store.recentForChat(jid, now - RETENTION_SECONDS, CONTEXT_MESSAGES), senderNamer(store));
}

/** Is the stored one-liner current for these unheard messages? */
export function summaryFresh(summaryUpto: number | null, unheard: MessageRow[]): boolean {
  const newest = unheard.reduce((max, m) => Math.max(max, m.rowid), 0);
  return summaryUpto !== null && summaryUpto >= newest;
}

/**
 * Rebuild a chat's roll-call one-liner over its unheard, non-trivial messages.
 * Returns the line, or null when there's nothing to summarize.
 */
export async function refreshSummaryLine(store: Store, tasks: Tasks, jid: string, now: number, timeoutMs?: number): Promise<string | null> {
  const unheard = store.unheardForChat(jid).filter((m) => !m.is_trivial);
  if (!unheard.length) {
    store.setSummary(jid, null, null);
    return null;
  }
  const chat = store.getChat(jid);
  const line = await tasks.summaryLine(displayName(store, jid), !!chat?.is_group, chatContext(store, jid, now), timeoutMs);
  store.setSummary(jid, line, Math.max(...unheard.map((m) => m.rowid)));
  return line;
}
