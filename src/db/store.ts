import type { DB } from './index.ts';
import type {
  CallRow, ChatRow, ContactRow, DraftRow, JobKind, JobRow, MessageRow, NewMessage, Tier, UsageEntry,
} from './types.ts';

/** All queries live here. Times are unix seconds. */
export class Store {
  constructor(readonly db: DB) {}

  // ---------- chats ----------

  upsertChat(c: { jid: string; name?: string | null; is_group?: boolean; archived?: boolean; unread_count?: number | null }, now: number) {
    this.db.prepare(`
      INSERT INTO chats (jid, name, is_group, archived, unread_count, updated_at)
      VALUES (@jid, @name, @is_group, @archived, @unread_count, @now)
      ON CONFLICT (jid) DO UPDATE SET
        name         = COALESCE(@name, name),
        is_group     = MAX(is_group, @is_group),
        archived     = COALESCE(@archived_upd, archived),
        unread_count = COALESCE(@unread_count, unread_count),
        updated_at   = @now
    `).run({
      jid: c.jid,
      name: c.name ?? null,
      is_group: c.is_group || c.jid.endsWith('@g.us') ? 1 : 0,
      archived: c.archived ? 1 : 0,
      archived_upd: c.archived === undefined ? null : c.archived ? 1 : 0,
      unread_count: c.unread_count ?? null,
      now,
    });
  }

  getChat(jid: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as ChatRow | undefined;
  }

  allChats(): ChatRow[] {
    return this.db.prepare('SELECT * FROM chats').all() as ChatRow[];
  }

  setTier(jid: string, tier: Tier) {
    this.db.prepare('UPDATE chats SET tier = ? WHERE jid = ?').run(tier, jid);
  }

  setSummary(jid: string, summary: string | null, upto: number | null) {
    this.db.prepare('UPDATE chats SET summary = ?, summary_upto = ? WHERE jid = ?').run(summary, upto, jid);
  }

  // ---------- contacts ----------

  upsertContact(c: { jid: string; lid?: string | null; name?: string | null; push_name?: string | null }) {
    const tx = this.db.transaction(() => {
      let alias: string | null = null;
      // An update addressed by LID belongs to the phone-JID row that already has that LID.
      if (c.jid.endsWith('@lid')) {
        const owner = this.db.prepare('SELECT jid FROM contacts WHERE lid = ?').get(c.jid) as { jid: string } | undefined;
        if (owner) c = { ...c, jid: owner.jid, lid: c.jid };
      }
      // A contact first seen only by LID gets merged into its phone-JID row once the mapping is known.
      if (c.lid && c.lid !== c.jid) {
        const byLid = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(c.lid) as ContactRow | undefined;
        if (byLid) {
          this.db.prepare('DELETE FROM contacts WHERE jid = ?').run(c.lid);
          c = { ...c, name: c.name ?? byLid.name, push_name: c.push_name ?? byLid.push_name };
          alias = byLid.alias;
        }
        this.db.prepare('UPDATE contacts SET lid = NULL WHERE lid = ? AND jid != ?').run(c.lid, c.jid);
      }
      this.db.prepare(`
        INSERT INTO contacts (jid, lid, name, push_name, alias) VALUES (@jid, @lid, @name, @push_name, @alias)
        ON CONFLICT (jid) DO UPDATE SET
          lid       = COALESCE(@lid, lid),
          name      = COALESCE(@name, name),
          push_name = COALESCE(@push_name, push_name),
          alias     = COALESCE(alias, @alias)
      `).run({ jid: c.jid, lid: c.lid ?? null, name: c.name ?? null, push_name: c.push_name ?? null, alias });
    });
    tx();
  }

  /** Replace all config-defined names. */
  setAliases(aliases: Map<string, string>) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE contacts SET alias = NULL WHERE alias IS NOT NULL').run();
      const ins = this.db.prepare('INSERT INTO contacts (jid, alias) VALUES (?, ?) ON CONFLICT (jid) DO UPDATE SET alias = excluded.alias');
      for (const [jid, alias] of aliases) ins.run(jid, alias);
    })();
  }

  /** Look a contact up by phone JID or LID. */
  findContact(jid: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE jid = ? OR lid = ?').get(jid, jid) as ContactRow | undefined;
  }

  /** How many contacts we have, and how many carry my address-book name (app-state sync working). */
  contactCounts(): { total: number; named: number } {
    return this.db.prepare('SELECT COUNT(*) AS total, COUNT(name) AS named FROM contacts').get() as { total: number; named: number };
  }

  allContacts(): ContactRow[] {
    return this.db.prepare('SELECT * FROM contacts').all() as ContactRow[];
  }

  /** Prefer the phone JID for a LID we have a mapping for. */
  canonicalJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const row = this.db.prepare('SELECT jid FROM contacts WHERE lid = ?').get(jid) as { jid: string } | undefined;
    return row?.jid ?? jid;
  }

  /**
   * Once a LID ↔ phone mapping arrives, move any chat and messages stored under the LID.
   * Returns true if anything moved.
   */
  mergeLidChat(lid: string, pn: string): boolean {
    const moved = this.db.transaction(() => {
      const lidChat = this.getChat(lid);
      if (!lidChat) return false;
      const pnChat = this.getChat(pn);
      if (!pnChat) this.db.prepare('UPDATE chats SET jid = ? WHERE jid = ?').run(pn, lid);
      else this.db.prepare('DELETE FROM chats WHERE jid = ?').run(lid);
      this.db.prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
      this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(lid);
      this.db.prepare('UPDATE drafts SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
      this.db.prepare("UPDATE jobs SET ref = ? WHERE kind = 'summarize' AND ref = ? AND status != 'pending'").run(pn, lid);
      this.db.prepare("DELETE FROM jobs WHERE kind = 'summarize' AND ref = ? AND status = 'pending'").run(lid);
      return true;
    })();
    return moved;
  }

  // ---------- messages ----------

  /** Returns the new rowid, or null if this message was already stored. */
  insertMessage(m: NewMessage): number | null {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, chat_jid, sender_jid, sender_name, from_me, type, raw_text, media_desc, media_ref,
         is_urgent, is_trivial, quoted_id, mentions_me, created_at)
      VALUES
        (@id, @chat_jid, @sender_jid, @sender_name, @from_me, @type, @raw_text, @media_desc, @media_ref,
         @is_urgent, @is_trivial, @quoted_id, @mentions_me, @created_at)
    `).run({ media_desc: null, is_urgent: null, ...m });
    return res.changes ? Number(res.lastInsertRowid) : null;
  }

  getMessage(rowid: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE rowid = ?').get(rowid) as MessageRow | undefined;
  }

  findMessage(chatJid: string, id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND id = ?').get(chatJid, id) as MessageRow | undefined;
  }

  /** One of my own messages by WhatsApp id (any chat). */
  findOwnMessage(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ? AND from_me = 1').get(id) as MessageRow | undefined;
  }

  updateMessage(rowid: number, fields: Partial<Pick<MessageRow, 'raw_text' | 'transcript' | 'media_desc' | 'media_ref' | 'is_urgent' | 'is_trivial'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE messages SET ${sets} WHERE rowid = @rowid`).run({ ...fields, rowid });
  }

  deleteMessage(chatJid: string, id: string) {
    this.db.prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?').run(chatJid, id);
  }

  /** Unheard incoming messages, oldest first. */
  unheard(): MessageRow[] {
    return this.db.prepare(`
      SELECT m.* FROM messages m JOIN chats c ON c.jid = m.chat_jid
      WHERE m.heard_at IS NULL AND m.from_me = 0 AND c.tier != 'muted'
      ORDER BY m.created_at, m.rowid
    `).all() as MessageRow[];
  }

  unheardForChat(jid: string): MessageRow[] {
    return this.db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? AND heard_at IS NULL AND from_me = 0
      ORDER BY created_at, rowid
    `).all(jid) as MessageRow[];
  }

  /** All messages (both directions) in a chat since a time, oldest first, capped to the newest `limit`. */
  recentForChat(jid: string, since: number, limit = 60): MessageRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? AND created_at >= ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(jid, since, limit) as MessageRow[];
    return rows.reverse();
  }

  /** Text search across text, transcripts and descriptions. */
  search(query: string, since: number, limit = 40): MessageRow[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.db.prepare(`
      SELECT m.* FROM messages m JOIN chats c ON c.jid = m.chat_jid
      WHERE c.tier != 'muted' AND m.created_at >= @since
        AND (m.raw_text LIKE @like ESCAPE '\\' OR m.transcript LIKE @like ESCAPE '\\' OR m.media_desc LIKE @like ESCAPE '\\')
      ORDER BY m.created_at DESC LIMIT @limit
    `).all({ like, since, limit }) as MessageRow[];
  }

  /** Which of these messages are still unheard. */
  stillUnheard(rowids: number[]): Set<number> {
    if (!rowids.length) return new Set();
    const rows = this.db.prepare(`SELECT rowid FROM messages WHERE heard_at IS NULL AND rowid IN (${rowids.map(() => '?').join(',')})`)
      .all(...rowids) as { rowid: number }[];
    return new Set(rows.map((r) => r.rowid));
  }

  markHeard(rowids: number[], now: number) {
    const stmt = this.db.prepare('UPDATE messages SET heard_at = ? WHERE rowid = ? AND heard_at IS NULL');
    this.db.transaction(() => rowids.forEach((id) => stmt.run(now, id)))();
  }

  /** The message just before this one in its chat (either direction). */
  messageBefore(jid: string, rowid: number, createdAt: number): MessageRow | undefined {
    return this.db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? AND type != 'reaction' AND (created_at < ? OR (created_at = ? AND rowid < ?))
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(jid, createdAt, createdAt, rowid) as MessageRow | undefined;
  }

  /** Newest message from someone else in a chat (the target of a quote-reply). */
  lastIncoming(jid: string): MessageRow | undefined {
    return this.db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? AND from_me = 0 AND type != 'reaction'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(jid) as MessageRow | undefined;
  }

  lastActivity(jid: string): number | null {
    const row = this.db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE chat_jid = ? AND from_me = 0').get(jid) as { t: number | null };
    return row.t;
  }

  /** Newest incoming message time per chat. */
  lastActivityAll(): Map<string, number> {
    const rows = this.db.prepare('SELECT chat_jid, MAX(created_at) AS t FROM messages WHERE from_me = 0 GROUP BY chat_jid').all() as { chat_jid: string; t: number }[];
    return new Map(rows.map((r) => [r.chat_jid, r.t]));
  }

  /** Images in this chat that have been, or are queued to be, described while unheard. */
  countDescribedUnheardImages(jid: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE chat_jid = ? AND type = 'image' AND heard_at IS NULL AND (media_desc IS NOT NULL OR media_ref IS NOT NULL)
    `).get(jid) as { n: number };
    return row.n;
  }

  // ---------- jobs ----------

  /**
   * Queue a job. With `debounce`, an existing pending job of the same kind/ref is pushed back
   * to `runAfter` instead of adding another.
   */
  enqueue(kind: JobKind, ref: string | number, runAfter: number, now: number, debounce = false) {
    const r = String(ref);
    if (debounce) {
      const res = this.db.prepare("UPDATE jobs SET run_after = ? WHERE kind = ? AND ref = ? AND status = 'pending'").run(runAfter, kind, r);
      if (res.changes) return;
    }
    this.db.prepare('INSERT OR IGNORE INTO jobs (kind, ref, run_after, created_at) VALUES (?, ?, ?, ?)').run(kind, r, runAfter, now);
  }

  /** Atomically take up to `limit` due jobs. */
  claimJobs(now: number, limit: number): JobRow[] {
    return this.db.transaction(() => {
      const jobs = this.db.prepare(`
        SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after, id LIMIT ?
      `).all(now, limit) as JobRow[];
      const mark = this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?");
      for (const j of jobs) mark.run(j.id);
      return jobs.map((j) => ({ ...j, status: 'running' as const, attempts: j.attempts + 1 }));
    })();
  }

  finishJob(id: number) {
    this.db.prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?").run(id);
  }

  /** Retry at `retryAt`, or give up when null. */
  failJob(id: number, error: string, retryAt: number | null) {
    const job = this.db.prepare('SELECT kind, ref FROM jobs WHERE id = ?').get(id) as { kind: string; ref: string } | undefined;
    if (retryAt !== null && job) {
      // A newer pending job for the same thing (e.g. a debounced summary) supersedes this retry.
      const newer = this.db.prepare("SELECT 1 FROM jobs WHERE kind = ? AND ref = ? AND status = 'pending'").get(job.kind, job.ref);
      if (newer) retryAt = null;
    }
    if (retryAt === null) this.db.prepare("UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?").run(error, id);
    else this.db.prepare("UPDATE jobs SET status = 'pending', last_error = ?, run_after = ? WHERE id = ?").run(error, retryAt, id);
  }

  /** Run again at `runAt` without counting this run as an attempt. */
  deferJob(id: number, runAt: number) {
    const job = this.db.prepare('SELECT kind, ref FROM jobs WHERE id = ?').get(id) as { kind: string; ref: string } | undefined;
    // A newer pending job for the same thing (a debounced summary) already covers it.
    if (job && this.db.prepare("SELECT 1 FROM jobs WHERE kind = ? AND ref = ? AND status = 'pending'").get(job.kind, job.ref)) {
      this.finishJob(id);
      return;
    }
    this.db.prepare("UPDATE jobs SET status = 'pending', attempts = MAX(attempts - 1, 0), run_after = ? WHERE id = ?").run(runAt, id);
  }

  /** After a crash, jobs left 'running' go back to the queue. */
  requeueRunningJobs(now: number) {
    this.db.prepare(`
      UPDATE OR IGNORE jobs SET status = 'pending', run_after = ? WHERE status = 'running'
    `).run(now);
    this.db.prepare("DELETE FROM jobs WHERE status = 'running'").run();
  }

  pendingJobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running')").get() as { n: number }).n;
  }

  // ---------- drafts ----------

  createDraft(d: { chat_jid: string; text: string; quoted_id: string | null }, now: number): DraftRow {
    const res = this.db.prepare(`
      INSERT INTO drafts (chat_jid, text, quoted_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `).run(d.chat_jid, d.text, d.quoted_id, now, now);
    return this.getDraft(Number(res.lastInsertRowid))!;
  }

  getDraft(id: number): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  }

  pendingDrafts(): DraftRow[] {
    return this.db.prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY updated_at DESC, id DESC").all() as DraftRow[];
  }

  setDraftStatus(id: number, status: DraftRow['status'], now: number) {
    this.db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  // ---------- calls ----------

  startCall(caller: string | null, now: number): number {
    this.db.prepare("UPDATE calls SET status = 'dropped' WHERE status = 'active'").run();
    return Number(this.db.prepare('INSERT INTO calls (caller, started_at) VALUES (?, ?)').run(caller, now).lastInsertRowid);
  }

  updateCall(id: number, fields: { current_chat: string | null; in_briefing: boolean }) {
    this.db.prepare('UPDATE calls SET current_chat = ?, in_briefing = ? WHERE id = ?').run(fields.current_chat, fields.in_briefing ? 1 : 0, id);
  }

  endCall(id: number, status: 'ended' | 'dropped', now: number) {
    this.db.prepare("UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'").run(status, now, id);
  }

  previousCall(beforeId: number): CallRow | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE id < ? ORDER BY id DESC LIMIT 1').get(beforeId) as CallRow | undefined;
  }

  // ---------- usage ----------

  logUsage(u: UsageEntry, now: number) {
    this.db.prepare(`
      INSERT INTO usage (ts, purpose, model, input_tokens, output_tokens, audio_seconds, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(now, u.purpose, u.model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.audio_seconds ?? 0, u.cost_usd);
  }

  usageSince(since: number): { purpose: string; model: string; calls: number; cost_usd: number }[] {
    return this.db.prepare(`
      SELECT purpose, model, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd FROM usage
      WHERE ts >= ? GROUP BY purpose, model ORDER BY cost_usd DESC
    `).all(since) as { purpose: string; model: string; calls: number; cost_usd: number }[];
  }

  // ---------- kv ----------

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- retention ----------

  /** Delete everything older than `cutoff` (SPEC §10.8). Returns the number of messages removed. */
  purgeBefore(cutoff: number): number {
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT rowid FROM messages WHERE created_at < ?').all(cutoff) as { rowid: number }[];
      const delJobs = this.db.prepare("DELETE FROM jobs WHERE kind != 'summarize' AND ref = ?");
      for (const { rowid } of old) delJobs.run(String(rowid));
      const n = this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes;
      // Summaries built only from deleted messages go too.
      this.db.prepare(`
        UPDATE chats SET summary = NULL, summary_upto = NULL
        WHERE summary IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_jid = chats.jid)
      `).run();
      this.db.prepare('DELETE FROM drafts WHERE updated_at < ?').run(cutoff);
      this.db.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < ?").run(cutoff);
      const legacy = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_messages'").get();
      if (legacy) {
        const newest = this.db.prepare('SELECT MAX(created_at) AS t FROM legacy_messages').get() as { t: number | null };
        if (!newest.t || newest.t < cutoff) this.db.exec('DROP TABLE legacy_messages');
      }
      return n;
    })();
  }
}
