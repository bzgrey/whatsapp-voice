import type { Store } from '../db/store.ts';
import { isRealName, normalizeName } from './names.ts';
import { jidPhone, normalizePhone } from './phone.ts';

/** Something that can be named: a contact (DM) or a group. */
export interface Entry {
  /** Canonical chat JID (phone JID for people when known). */
  jid: string;
  /** Other JIDs for the same person (their LID). */
  aliases: string[];
  isGroup: boolean;
  /** Names to match on, best first (address-book, push name, group subject). */
  names: string[];
  label: string;
  lastActivity: number | null;
}

export type Resolution =
  | { status: 'ok'; entry: Entry }
  | { status: 'ambiguous'; matches: Entry[] }
  | { status: 'unknown' };

/** Everyone and every group we know about. */
export function buildDirectory(store: Store): Entry[] {
  const out = new Map<string, Entry>();
  const activity = store.lastActivityAll();
  for (const c of store.allContacts()) {
    const names = [c.alias, c.name, c.push_name].filter(isRealName);
    out.set(c.jid, {
      jid: c.jid,
      aliases: c.lid && c.lid !== c.jid ? [c.lid] : [],
      isGroup: false,
      names,
      label: names[0] ?? c.jid,
      lastActivity: activity.get(c.jid) ?? (c.lid ? activity.get(c.lid) : undefined) ?? null,
    });
  }
  const lids = new Set([...out.values()].flatMap((e) => e.aliases));
  for (const chat of store.allChats()) {
    if (out.has(chat.jid) || lids.has(chat.jid)) continue;
    const names = chat.name ? [chat.name] : [];
    out.set(chat.jid, {
      jid: chat.jid,
      aliases: [],
      isGroup: !!chat.is_group,
      names,
      label: names[0] ?? chat.jid,
      lastActivity: activity.get(chat.jid) ?? null,
    });
  }
  return [...out.values()];
}

const byJid = (dir: Entry[], jid: string) => dir.find((e) => e.jid === jid || e.aliases.includes(jid));

/**
 * A JID or phone number written directly, rather than a name. Applies even
 * before we've seen that chat (e.g. a flagged parent who hasn't messaged yet).
 */
function literal(dir: Entry[], text: string, kind?: 'person' | 'group'): Entry | undefined {
  const unseen = (jid: string): Entry | undefined => {
    const isGroup = jid.endsWith('@g.us');
    if (kind && isGroup !== (kind === 'group')) return undefined;
    return { jid, aliases: [], isGroup, names: [], label: jid, lastActivity: null };
  };
  if (text.includes('@')) return byJid(dir, text.trim()) ?? unseen(text.trim());
  const digits = text.replace(/[\s()+.-]/g, '');
  if (/^\d{7,}$/.test(digits)) {
    const pn = normalizePhone(digits);
    return dir.find((e) => jidPhone(e.jid) === pn) ?? unseen(`${pn}@s.whatsapp.net`);
  }
  return undefined;
}

const isLiteral = (text: string) => text.includes('@') || /^\+?[\d\s().-]{7,}$/.test(text.trim());

/**
 * Exact resolution for config entries: a JID, a phone number, or a full name
 * (case/accents ignored). `kind` limits matches to people or groups.
 */
export function resolveExact(dir: Entry[], text: string, kind?: 'person' | 'group'): Resolution {
  const pool = kind ? dir.filter((e) => e.isGroup === (kind === 'group')) : dir;
  if (isLiteral(text)) {
    const lit = literal(pool, text, kind);
    return lit ? { status: 'ok', entry: lit } : { status: 'unknown' };
  }
  const q = normalizeName(text);
  const matches = pool.filter((e) => e.names.some((n) => normalizeName(n) === q));
  if (matches.length === 1) return { status: 'ok', entry: matches[0]! };
  if (matches.length > 1) {
    // An address-book name beats someone else's push name.
    const primary = matches.filter((e) => normalizeName(e.names[0] ?? '') === q);
    if (primary.length === 1) return { status: 'ok', entry: primary[0]! };
    return { status: 'ambiguous', matches };
  }
  return { status: 'unknown' };
}

function score(names: string[], q: string): number {
  const qTokens = q.split(' ');
  let best = 0;
  names.forEach((name, i) => {
    const n = normalizeName(name);
    if (!n) return;
    const penalty = i === 0 ? 0 : 5;
    const nTokens = n.split(' ');
    let s = 0;
    if (n === q) s = 100;
    else if (qTokens.every((t) => nTokens.some((nt) => nt === t))) s = 85;
    else if (qTokens.every((t) => nTokens.some((nt) => nt.startsWith(t)))) s = 70;
    else if (n.includes(q)) s = 50;
    best = Math.max(best, s ? s - penalty : 0);
  });
  return best;
}

/**
 * Loose resolution for spoken names ("Yossi", "the shiur group"). Returns the best
 * match, or every equally good match when ambiguous.
 */
export function resolveSpoken(dir: Entry[], text: string, kind?: 'person' | 'group'): Resolution {
  const pool = kind ? dir.filter((e) => e.isGroup === (kind === 'group')) : dir;
  if (isLiteral(text)) {
    const lit = literal(pool, text, kind);
    return lit ? { status: 'ok', entry: lit } : { status: 'unknown' };
  }
  const q = normalizeName(text.replace(/^(the|my)\s+/i, '').replace(/\s+(group|chat)$/i, ''));
  if (!q) return { status: 'unknown' };
  const scored = pool.map((e) => ({ e, s: score(e.names, q) })).filter((x) => x.s > 0);
  if (!scored.length) return { status: 'unknown' };
  const top = Math.max(...scored.map((x) => x.s));
  const best = scored.filter((x) => x.s === top).map((x) => x.e);
  if (best.length === 1) return { status: 'ok', entry: best[0]! };
  return { status: 'ambiguous', matches: best.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)) };
}

/** Narrow a candidate list with an LLM, for names in another script ("Yossi" vs "יוסי"). */
export type NameMatcher = (query: string, candidates: { id: number; names: string[] }[]) => Promise<number[]>;

export async function resolveSpokenWithFallback(
  dir: Entry[], text: string, kind: 'person' | 'group' | undefined, matcher?: NameMatcher,
): Promise<Resolution> {
  const local = resolveSpoken(dir, text, kind);
  if (local.status !== 'unknown' || !matcher) return local;
  const pool = (kind ? dir.filter((e) => e.isGroup === (kind === 'group')) : dir).filter((e) => e.names.length);
  if (!pool.length) return local;
  const ids = await matcher(text, pool.map((e, id) => ({ id, names: e.names })));
  const matches = ids.map((i) => pool[i]).filter((e): e is Entry => !!e);
  if (matches.length === 1) return { status: 'ok', entry: matches[0]! };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return local;
}
