import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { saveMessage } from './db.js';
import { classify } from './classify.js';

const groups = new Set(
  (process.env.WHITELISTED_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

let sock;
let pairingRequested = false;

const extractText = (msg) =>
  msg.conversation ||
  msg.extendedTextMessage?.text ||
  msg.imageMessage?.caption ||
  msg.videoMessage?.caption ||
  '';

export async function startWhatsApp({ onUrgent } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'warn' }) });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const phone = (process.env.PAIRING_PHONE || '').replace(/\D/g, '');
      if (phone && !state.creds.registered) {
        if (!pairingRequested) {
          pairingRequested = true;
          sock.requestPairingCode(phone)
            .then((code) => console.log(`\nPairing code: ${code}\nWhatsApp > Linked Devices > Link with phone number instead\n`))
            .catch((err) => { pairingRequested = false; console.error('pairing code failed:', err.message); });
        }
      } else {
        qrcode.generate(qr, { small: true });
      }
    }
    if (connection === 'open') console.log('WhatsApp connected');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (status ${code}: ${lastDisconnect?.error?.message})`);
      if (code === DisconnectReason.loggedOut) {
        console.error('LOGGED OUT of WhatsApp. Delete auth_session/ and re-pair.');
        pairingRequested = false;
      } else {
        console.log('Connection closed, reconnecting...');
        startWhatsApp({ onUrgent });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!jid || m.key.fromMe || jid === 'status@broadcast') continue;
      const isGroup = jid.endsWith('@g.us');
      const isDirect = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
      if (isGroup ? !groups.has(jid) : !isDirect) {
        console.log(`skipped message from ${jid} (not a direct chat or whitelisted group)`);
        continue;
      }

      const text = extractText(m.message || {});
      if (!text) {
        console.log(`skipped non-text message from ${jid}: ${Object.keys(m.message || {}).join(',')}`);
        continue;
      }

      const name = m.pushName || jid.split('@')[0];
      const c = await classify(name, text);
      const row = {
        id: m.key.id,
        sender_jid: m.key.participant || jid,
        sender_name: name,
        raw_text: text,
        summary: c.summary,
        is_urgent: c.is_urgent ? 1 : 0,
        requires_callback: c.requires_callback ? 1 : 0,
        created_at: Math.floor(Date.now() / 1000),
      };
      saveMessage(row);
      console.log(`[${row.is_urgent ? 'URGENT' : 'msg'}] ${name}: ${c.summary}`);
      if (row.is_urgent && onUrgent) onUrgent(row);
    }
  });
}

export const sendWhatsAppMessage = (jid, text) => sock.sendMessage(jid, { text });

export async function listGroups() {
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ jid: g.id, name: g.subject }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
