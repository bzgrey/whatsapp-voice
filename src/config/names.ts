import type { Store } from '../db/store.ts';
import { jidPhone, speakableNumber } from './phone.ts';

/** Lowercase, strip accents/niqqud, punctuation and emoji, collapse spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-֑ͯ-ׇ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Speakable name for a chat or person: address-book name, then their push name,
 * then the group subject, then the number (SPEC §7).
 */
export function displayName(store: Store, jid: string, fallbackPushName?: string | null): string {
  if (jid.endsWith('@g.us')) return store.getChat(jid)?.name ?? 'an unnamed group';
  const c = store.findContact(jid);
  return c?.name || c?.push_name || fallbackPushName || (jidPhone(jid) ? speakableNumber(jid) : 'someone');
}
