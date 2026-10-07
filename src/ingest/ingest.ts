import type { ConfigSync } from '../config/sync.ts';
import type { Store } from '../db/store.ts';
import { RETENTION_SECONDS } from '../env.ts';
import { log } from '../log.ts';
import { MAX_DESCRIBED_IMAGES } from '../briefing/render.ts';
import { obviouslyTrivial } from '../llm/tasks.ts';
import { displayName } from '../config/names.ts';
import { bareJid, isMe, isSupportedJid, shouldStore, type Me } from './filter.ts';
import type { Extracted } from './extract.ts';

/** Wait this long after a chat's last message before (re)summarizing it (SPEC §10.2). */
export const SUMMARY_DEBOUNCE_SECONDS = 90;

/**
 * Filter → store raw immediately → queue enrichment (SPEC §10.2 steps 1–3).
 * `mediaRef` serializes the original message for a later media download.
 */
export class Ingest {
  constructor(
    private store: Store,
    private config: ConfigSync,
    private me: () => Me,
    private now: () => number,
  ) {}

  /** Called the first time a group is seen, to look up its name. */
  onNewGroup?: (jid: string) => void;

  /** Record a LID ↔ phone mapping and move anything stored under the LID. */
  mapLid(lid: string, pn: string) {
    lid = bareJid(lid);
    pn = bareJid(pn);
    this.store.upsertContact({ jid: pn, lid });
    if (this.store.mergeLidChat(lid, pn)) this.config.scheduleRefresh();
  }

  /** The chat JID we store under: the phone JID when we know it. */
  private chatJid(ex: Extracted): string {
    const jid = bareJid(ex.remoteJid);
    if (jid.endsWith('@lid') && ex.remoteJidAlt?.endsWith('@s.whatsapp.net')) {
      this.mapLid(jid, ex.remoteJidAlt);
      return bareJid(ex.remoteJidAlt);
    }
    return this.store.canonicalJid(jid);
  }

  private senderJid(ex: Extracted, chatJid: string, isGroup: boolean): string | null {
    const me = this.me();
    if (ex.fromMe) return me.pn ?? me.lid;
    if (!isGroup) return chatJid;
    if (!ex.participant) return null;
    const p = bareJid(ex.participant);
    if (p.endsWith('@lid') && ex.participantAlt?.endsWith('@s.whatsapp.net')) {
      this.store.upsertContact({ jid: bareJid(ex.participantAlt), lid: p });
      return bareJid(ex.participantAlt);
    }
    return this.store.canonicalJid(p);
  }

  /** Returns the stored rowid, or null if skipped. */
  handle(ex: Extracted, mediaRef: () => string): number | null {
    if (!isSupportedJid(ex.remoteJid)) return null;
    const now = this.now();
    const chatJid = this.chatJid(ex);
    const isGroup = chatJid.endsWith('@g.us');

    if (!this.store.getChat(chatJid)) {
      this.config.upsertChat({ jid: chatJid, is_group: isGroup }, now);
      if (isGroup) this.onNewGroup?.(chatJid);
    }
    const chat = this.store.getChat(chatJid)!;
    const sender = this.senderJid(ex, chatJid, isGroup);
    if (!ex.fromMe && sender && ex.pushName) this.store.upsertContact({ jid: sender, push_name: ex.pushName });

    if (ex.protocol) {
      const target = this.store.findMessage(chatJid, ex.protocol.targetId);
      if (!target) return null;
      if (ex.protocol.kind === 'revoke') this.store.deleteMessage(chatJid, target.id);
      else {
        this.store.updateMessage(target.rowid, { raw_text: ex.protocol.text ?? null });
        if (!target.from_me) this.queueClassify(target.rowid, now);
      }
      if (!target.from_me) this.store.enqueue('summarize', chatJid, now + SUMMARY_DEBOUNCE_SECONDS, now, true);
      return null;
    }

    const me = this.me();
    const mentionsMe = ex.mentionedJids.some((j) => isMe(j, me));
    const quotesMe = isMe(ex.quotedParticipant, me) || (!!ex.quotedId && !!this.store.findMessage(chatJid, ex.quotedId)?.from_me);
    if (!shouldStore(chat.tier, { fromMe: ex.fromMe, mentionsMe, quotesMe })) return null;
    if (ex.timestamp < now - RETENTION_SECONDS) return null;

    const autoTrivial = ex.type === 'reaction' || ex.type === 'sticker'
      || (ex.type === 'text' && !ex.mediaDesc && obviouslyTrivial(ex.text ?? ''));
    const describe = ex.type === 'image' && this.store.countDescribedUnheardImages(chatJid) < MAX_DESCRIBED_IMAGES;
    const download = !ex.fromMe && (ex.type === 'voice' || describe);

    const rowid = this.store.insertMessage({
      id: ex.id,
      chat_jid: chatJid,
      sender_jid: sender,
      sender_name: ex.fromMe ? null : ex.pushName,
      from_me: ex.fromMe ? 1 : 0,
      type: ex.type,
      raw_text: ex.text,
      media_desc: ex.mediaDesc,
      media_ref: download ? mediaRef() : null,
      is_urgent: ex.fromMe || autoTrivial ? 0 : null,
      is_trivial: ex.fromMe ? 0 : autoTrivial ? 1 : null,
      quoted_id: ex.quotedId,
      mentions_me: mentionsMe ? 1 : 0,
      created_at: ex.timestamp,
    });
    if (rowid === null) return null;

    log.info(`stored ${ex.fromMe ? 'outgoing' : 'incoming'} ${ex.type} in ${displayName(this.store, chatJid, isGroup ? null : ex.pushName)}`);
    if (ex.fromMe) {
      // Replying (or reacting) means I've seen everything before it: don't brief it again.
      if (this.store.markHeardUpTo(chatJid, ex.timestamp, now)) this.store.enqueue('summarize', chatJid, now, now, true);
      return rowid;
    }

    if (ex.type === 'voice') this.store.enqueue('transcribe', rowid, now, now);
    else if (describe) this.store.enqueue('describe', rowid, now, now);
    else if (!autoTrivial) this.queueClassify(rowid, now);
    this.store.enqueue('summarize', chatJid, now + SUMMARY_DEBOUNCE_SECONDS, now, true);
    return rowid;
  }

  private queueClassify(rowid: number, now: number) {
    this.store.enqueue('classify', rowid, now, now);
  }
}
