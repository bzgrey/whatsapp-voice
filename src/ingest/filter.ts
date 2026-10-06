import type { Tier } from '../db/types.ts';

/** Chats we handle: people (phone JID or LID) and groups. Not status, newsletters or broadcasts. */
export function isSupportedJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@g.us');
}

export interface Me {
  /** Phone JID without device suffix, e.g. 972…@s.whatsapp.net */
  pn: string | null;
  lid: string | null;
}

/** Strip a device suffix: "972…:12@s.whatsapp.net" → "972…@s.whatsapp.net". */
export const bareJid = (jid: string) => jid.replace(/:\d+@/, '@');

export function isMe(jid: string | null | undefined, me: Me): boolean {
  if (!jid) return false;
  const j = bareJid(jid);
  return j === me.pn || j === me.lid;
}

/**
 * Should this message be stored (SPEC §2.1, §2.6)? Muted chats never;
 * mentions-only groups only when I'm @mentioned or quote-replied, or it's my own message.
 */
export function shouldStore(tier: Tier, m: { fromMe: boolean; mentionsMe: boolean; quotesMe: boolean }): boolean {
  if (tier === 'muted') return false;
  if (tier === 'mentions') return m.fromMe || m.mentionsMe || m.quotesMe;
  return true;
}
