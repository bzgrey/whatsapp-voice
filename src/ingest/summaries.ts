import type { Store } from '../db/store.ts';
import type { MessageRow } from '../db/types.ts';
import { RETENTION_SECONDS } from '../env.ts';
import { displayName } from '../config/names.ts';
import { contextLines } from '../briefing/render.ts';
import type { Tasks } from '../llm/tasks.ts';

/** How many messages of earlier context go with the new ones. */
const CONTEXT_MESSAGES = 40;

export const senderNamer = (store: Store) => (m: MessageRow) =>
  m.from_me ? 'Me' : m.sender_jid ? displayName(store, m.sender_jid, m.sender_name) : (m.sender_name ?? 'someone');

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
