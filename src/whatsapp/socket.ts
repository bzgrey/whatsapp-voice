import makeWASocket, {
  BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState,
  type proto, type WAMessage, type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { ConfigSync } from '../config/sync.ts';
import type { Store } from '../db/store.ts';
import type { MessageRow } from '../db/types.ts';
import type { Sender } from '../briefing/session.ts';
import type { MediaFetcher } from '../ingest/enrich.ts';
import { extract } from '../ingest/extract.ts';
import { bareJid, isSupportedJid, type Me } from '../ingest/filter.ts';
import type { Ingest } from '../ingest/ingest.ts';
import { errMsg, log } from '../log.ts';
import { setWaStatus } from './status.ts';

interface Deps {
  store: Store;
  config: ConfigSync;
  ingest: Ingest;
  authDir: string;
  pairingPhone: string;
  now: () => number;
}

/**
 * The Baileys companion connection. Never marks anything read and never shows
 * me online (SPEC §3.7): no readMessages / read receipts, markOnlineOnConnect off.
 */
export class WhatsApp implements Sender, MediaFetcher {
  private sock: WASocket | undefined;
  private pairingRequested = false;
  private stopped = false;
  me: Me = { pn: null, lid: null };
  /** Exact content of messages sent from this companion, for retry receipts (kept 1 day). */
  private sent = new Map<string, { message: proto.IMessage; at: number }>();

  constructor(private d: Deps) {}

  get connected() { return !!this.sock?.user; }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.d.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'error' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // When a recipient can't decrypt something we sent, Baileys re-encrypts it from here.
      getMessage: async (key) => this.lookupSent(key.id),
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    // A bad event must never take the process down.
    const on: typeof sock.ev.on = (event, handler) => sock.ev.on(event, (arg: any) => {
      try { (handler as (a: unknown) => void)(arg); } catch (err) { log.error(`whatsapp ${String(event)} handler failed: ${errMsg(err)}`); }
    });

    on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) this.showPairing(qr, !!state.creds.registered);
      if (connection === 'open') {
        this.me = { pn: sock.user?.id ? bareJid(sock.user.id) : null, lid: sock.user?.lid ? bareJid(sock.user.lid) : null };
        setWaStatus(this.d.store, 'open', this.d.now());
        log.info('whatsapp: connected');
        void this.syncGroupNames();
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          setWaStatus(this.d.store, 'logged_out', this.d.now());
          log.error(`whatsapp: LOGGED OUT. Delete ${this.d.authDir}/ and re-pair.`);
          this.pairingRequested = false;
          return;
        }
        setWaStatus(this.d.store, 'closed', this.d.now());
        log.warn(`whatsapp: connection closed (${code}: ${lastDisconnect?.error?.message}), reconnecting`);
        if (!this.stopped) setTimeout(() => void this.start().catch((e) => log.error(`whatsapp: restart failed: ${errMsg(e)}`)), 2000);
      }
    });

    on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) this.onMessage(m);
    });

    // Names and archive state (SPEC §8 open questions 4, 5).
    on('messaging-history.set', ({ chats, contacts, lidPnMappings }) => {
      lidPnMappings?.forEach((x) => this.d.ingest.mapLid(x.lid, x.pn));
      contacts.forEach((c) => this.onContact(c));
      chats.forEach((c) => this.onChat(c));
      this.d.config.scheduleRefresh();
    });
    on('contacts.upsert', (cs) => { cs.forEach((c) => this.onContact(c)); this.d.config.scheduleRefresh(); });
    on('contacts.update', (cs) => { cs.forEach((c) => this.onContact(c)); this.d.config.scheduleRefresh(); });
    on('chats.upsert', (cs) => { cs.forEach((c) => this.onChat(c)); this.d.config.scheduleRefresh(); });
    on('chats.update', (cs) => { cs.forEach((c) => this.onChat(c)); this.d.config.scheduleRefresh(); });
    on('lid-mapping.update', ({ lid, pn }) => this.d.ingest.mapLid(lid, pn));
    on('groups.upsert', (gs) => { gs.forEach((g) => this.setGroupName(g.id, g.subject)); this.d.config.scheduleRefresh(); });
    on('groups.update', (gs) => { gs.forEach((g) => g.id && g.subject && this.setGroupName(g.id, g.subject)); this.d.config.scheduleRefresh(); });
    this.d.ingest.onNewGroup = (jid) => void sock.groupMetadata(jid)
      .then((g) => { this.setGroupName(g.id, g.subject); this.d.config.scheduleRefresh(); })
      .catch((err) => log.warn(`group name lookup failed: ${errMsg(err)}`));
  }

  private setGroupName(jid: string, name: string | undefined) {
    if (name) this.d.config.upsertChat({ jid, name, is_group: true }, this.d.now());
  }

  /** Group subjects aren't in the chat sync; fetch them once per connection. */
  private async syncGroupNames() {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      for (const g of Object.values(groups)) this.setGroupName(g.id, g.subject);
      this.d.config.refresh();
      log.info(`whatsapp: ${Object.keys(groups).length} groups`);
    } catch (err) {
      log.warn(`group sync failed: ${errMsg(err)}`);
    }
  }

  stop() {
    this.stopped = true;
    this.sock?.end(undefined);
  }

  private showPairing(qr: string, registered: boolean) {
    const phone = this.d.pairingPhone.replace(/\D/g, '');
    if (phone && !registered) {
      if (this.pairingRequested) return;
      this.pairingRequested = true;
      this.sock!.requestPairingCode(phone)
        .then((code) => console.log(`\nPairing code: ${code}\nWhatsApp > Linked Devices > Link with phone number instead\n`))
        .catch((err) => { this.pairingRequested = false; log.error(`pairing code failed: ${errMsg(err)}`); });
    } else {
      qrcode.generate(qr, { small: true });
    }
  }

  private onMessage(m: WAMessage) {
    try {
      const ex = extract(m);
      if (!ex) return;
      this.d.ingest.handle(ex, () => JSON.stringify(m, BufferJSON.replacer));
    } catch (err) {
      log.error(`ingest failed: ${errMsg(err)}`);
    }
  }

  private onContact(c: { id?: string; lid?: string; phoneNumber?: string; name?: string; notify?: string }) {
    if (!c.id) return;
    const id = bareJid(c.id);
    const pn = c.phoneNumber ? bareJid(c.phoneNumber) : id.endsWith('@s.whatsapp.net') ? id : null;
    const lid = c.lid ? bareJid(c.lid) : id.endsWith('@lid') ? id : null;
    const jid = pn ?? lid;
    if (!jid || !isSupportedJid(jid) || jid.endsWith('@g.us')) return;
    if (pn && lid) this.d.ingest.mapLid(lid, pn);
    this.d.store.upsertContact({ jid, lid, name: c.name || null, push_name: c.notify || null });
  }

  private onChat(c: { id?: string | null; name?: string | null; archived?: boolean | null; unreadCount?: number | null }) {
    if (!c.id || !isSupportedJid(c.id)) return;
    const jid = this.d.store.canonicalJid(bareJid(c.id));
    this.d.config.upsertChat({
      jid,
      name: jid.endsWith('@g.us') ? c.name ?? null : null,
      archived: c.archived == null ? undefined : !!c.archived,
      unread_count: c.unreadCount ?? null,
    }, this.d.now());
  }

  /** Group names and JIDs, for writing config.yaml. */
  async listGroups() {
    if (!this.sock?.user) throw new Error('WhatsApp not connected');
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ jid: g.id, name: g.subject })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- Sender ----------

  async sendText(jid: string, text: string, quoted: MessageRow | null) {
    const sock = this.sock;
    if (!sock?.user) throw new Error('WhatsApp not connected');
    const unreadBefore = this.d.store.getChat(jid)?.unread_count ?? 0;
    const quotedMsg: WAMessage | undefined = quoted ? {
      key: { remoteJid: jid, id: quoted.id, fromMe: !!quoted.from_me, participant: jid.endsWith('@g.us') ? quoted.sender_jid ?? undefined : undefined },
      message: { conversation: quoted.raw_text ?? quoted.transcript ?? '' },
    } : undefined;
    const sent = await sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
    if (sent?.key.id && sent.message) this.rememberSent(sent.key.id, sent.message);
    // If WhatsApp marks the chat read on my phone when the companion sends, put it back (SPEC open question 9).
    if (this.d.config.config.restore_unread_after_send && unreadBefore > 0 && sent) {
      await sock.chatModify({ markRead: false, lastMessages: [{ key: sent.key, messageTimestamp: sent.messageTimestamp }] }, jid)
        .catch((err) => log.warn(`restore unread failed: ${errMsg(err)}`));
    }
  }

  private rememberSent(id: string, message: proto.IMessage) {
    const now = this.d.now();
    for (const [k, v] of this.sent) if (now - v.at > 86400) this.sent.delete(k);
    this.sent.set(id, { message, at: now });
  }

  private async lookupSent(id: string | null | undefined): Promise<proto.IMessage | undefined> {
    if (!id) return undefined;
    const hit = this.sent.get(id);
    if (hit) return hit.message;
    // Sent from my phone or before a restart: the stored text is the best we have.
    const row = this.d.store.findOwnMessage(id);
    return row?.raw_text ? { conversation: row.raw_text } : undefined;
  }

  // ---------- MediaFetcher ----------

  async download(mediaRef: string) {
    const sock = this.sock;
    if (!sock) throw new Error('WhatsApp not connected');
    const msg = JSON.parse(mediaRef, BufferJSON.reviver) as WAMessage;
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'error' }),
      reuploadRequest: sock.updateMediaMessage,
    });
    const content = msg.message?.ephemeralMessage?.message ?? msg.message?.viewOnceMessageV2?.message ?? msg.message;
    const media = content?.audioMessage ?? content?.imageMessage;
    return { buffer, mime: media?.mimetype ?? 'application/octet-stream', seconds: content?.audioMessage?.seconds ?? null };
  }
}
