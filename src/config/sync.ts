import { existsSync, readFileSync, unwatchFile, watchFile, writeFileSync, renameSync } from 'node:fs';
import YAML from 'yaml';
import type { Store } from '../db/store.ts';
import type { ChatRow, Tier } from '../db/types.ts';
import { log } from '../log.ts';
import { buildDirectory, resolveExact, type Entry } from './resolve.ts';
import { DEFAULT_CONFIG, parseConfig, type Config } from './schema.ts';
import { jidPhone, speakableNumber } from './phone.ts';

export type TierAction = 'flag' | 'unflag' | 'mute' | 'unmute';

interface Resolved {
  flagged: Set<string>;
  muted: Set<string>;
  whitelisted: Set<string>;
}

/** Pure tier rule (SPEC §2.1). */
export function computeTier(chat: Pick<ChatRow, 'jid' | 'is_group' | 'archived'>, r: Resolved): Tier {
  if (chat.archived || r.muted.has(chat.jid)) return 'muted';
  if (r.flagged.has(chat.jid)) return 'flagged';
  if (chat.is_group) return r.whitelisted.has(chat.jid) ? 'normal' : 'mentions';
  return 'normal';
}

/**
 * config.yaml ↔ SQLite. The DB holds the live tiers; the file is watched and
 * re-applied on edit; voice changes rewrite the file. Last change wins.
 */
export class ConfigSync {
  config: Config = DEFAULT_CONFIG;
  private resolved: Resolved = { flagged: new Set(), muted: new Set(), whitelisted: new Set() };
  private lastWritten = '';
  private lastWarnings = '';
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private store: Store, readonly file: string) {}

  /** Load the file (if any) and apply tiers. Throws on an invalid file at startup. */
  load() {
    if (existsSync(this.file)) this.config = parseConfig(YAML.parse(readFileSync(this.file, 'utf8')));
    else log.warn(`config: ${this.file} not found, using defaults (no PIN, nothing flagged)`);
    this.refresh();
  }

  /** Re-apply the file when it changes on disk. */
  watch() {
    watchFile(this.file, { interval: 1000 }, () => {
      let text: string;
      try { text = readFileSync(this.file, 'utf8'); } catch { return; }
      if (text === this.lastWritten) return;
      try {
        this.config = parseConfig(YAML.parse(text));
        log.info('config: reloaded');
        this.refresh();
      } catch (err) {
        log.error(`config: ignoring invalid edit: ${(err as Error).message}`);
      }
    });
  }

  stop() {
    unwatchFile(this.file);
    clearTimeout(this.refreshTimer);
  }

  /** Re-resolve names soon (contacts or chats changed). */
  scheduleRefresh(delayMs = 2000) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delayMs);
  }

  /** Resolve every configured name and recompute every chat's tier. */
  refresh() {
    const warnings: string[] = [];
    const aliases = new Map<string, string>();
    const before = buildDirectory(this.store);
    for (const [who, name] of Object.entries(this.config.names)) {
      const r = resolveExact(before, who, 'person');
      if (r.status === 'ok') aliases.set(r.entry.jid, name);
      else warnings.push(`names: "${who}" ${r.status === 'ambiguous' ? 'is ambiguous; use a number' : 'not found (yet)'}`);
    }
    this.store.setAliases(aliases);
    const dir = buildDirectory(this.store);
    const resolveList = (list: string[], key: string, kind?: 'person' | 'group') => {
      const set = new Set<string>();
      for (const name of list) {
        const r = resolveExact(dir, name, kind);
        if (r.status === 'ok') [r.entry.jid, ...r.entry.aliases].forEach((j) => set.add(j));
        else if (r.status === 'ambiguous') warnings.push(`${key}: "${name}" matches ${r.matches.length} chats (${r.matches.map((m) => m.label).join(', ')}); use a number or JID`);
        else warnings.push(`${key}: "${name}" not found (yet)`);
      }
      return set;
    };
    this.resolved = {
      flagged: resolveList(this.config.flagged, 'flagged'),
      muted: resolveList(this.config.muted, 'muted'),
      whitelisted: resolveList(this.config.whitelisted_groups, 'whitelisted_groups', 'group'),
    };
    const w = warnings.join('\n');
    if (w && w !== this.lastWarnings) w.split('\n').forEach((line) => log.warn(`config: ${line}`));
    this.lastWarnings = w;
    for (const chat of this.store.allChats()) {
      const tier = computeTier(chat, this.resolved);
      if (tier !== chat.tier) this.store.setTier(chat.jid, tier);
    }
  }

  /**
   * Create or update a chat and set its tier right away, so a message arriving
   * before the next refresh is filtered correctly (new chats, archive changes).
   */
  upsertChat(c: Parameters<Store['upsertChat']>[0], now: number) {
    this.store.upsertChat(c, now);
    const chat = this.store.getChat(c.jid)!;
    const tier = computeTier(chat, this.resolved);
    if (tier !== chat.tier) this.store.setTier(chat.jid, tier);
  }

  /** Tier for a chat right now (used when a new chat appears). */
  tierFor(chat: Pick<ChatRow, 'jid' | 'is_group' | 'archived'>): Tier {
    return computeTier(chat, this.resolved);
  }

  /**
   * Apply a voice command ("flag Yossi") to a chat and rewrite config.yaml.
   * Returns a sentence to say back.
   */
  applyVoice(entry: Entry, action: TierAction): string {
    const dir = buildDirectory(this.store);
    const jids = new Set([entry.jid, ...entry.aliases]);
    const isThis = (name: string) => {
      const r = resolveExact(dir, name);
      return r.status === 'ok' && jids.has(r.entry.jid);
    };
    // Write a name only if it's unambiguous; otherwise the number or JID.
    const unique = entry.names.find((n) => resolveExact(dir, n).status === 'ok');
    const label = unique ?? (jidPhone(entry.jid) ? speakableNumber(entry.jid).replace(/ /g, '') : entry.jid);
    const c = { ...this.config };
    const without = (list: string[]) => list.filter((n) => !isThis(n));
    const chat = this.store.getChat(entry.jid);
    let reply: string;
    switch (action) {
      case 'flag':
        c.muted = without(c.muted);
        c.flagged = c.flagged.some(isThis) ? c.flagged : [...c.flagged, label];
        reply = `${entry.label} is flagged. Their messages will be read out in full.`;
        break;
      case 'unflag':
        c.flagged = without(c.flagged);
        reply = `${entry.label} is no longer flagged.`;
        break;
      case 'mute':
        c.flagged = without(c.flagged);
        c.muted = c.muted.some(isThis) ? c.muted : [...c.muted, label];
        reply = `${entry.label} is muted.`;
        break;
      case 'unmute':
        c.muted = without(c.muted);
        reply = chat?.archived
          ? `${entry.label} is removed from the mute list, but the chat is archived on your phone, so it stays muted until it's unarchived.`
          : `${entry.label} is unmuted.`;
        break;
    }
    this.config = c;
    this.write();
    this.refresh();
    return reply;
  }

  private write() {
    let doc: YAML.Document;
    try { doc = YAML.parseDocument(readFileSync(this.file, 'utf8')); } catch { doc = new YAML.Document({}); }
    doc.set('flagged', this.config.flagged);
    doc.set('muted', this.config.muted);
    const text = doc.toString();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.lastWritten = text;
  }
}
