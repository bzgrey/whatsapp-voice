import { describe, expect, it } from 'vitest';
import { extract } from '../src/ingest/extract.ts';
import { bareJid, isMe, isSupportedJid, shouldStore } from '../src/ingest/filter.ts';
import { callerFromSip, normalizePhone, speakableNumber } from '../src/config/phone.ts';

const key = { id: 'A1', remoteJid: '972501111111@s.whatsapp.net', fromMe: false };

describe('extract', () => {
  it('reads plain and extended text', () => {
    expect(extract({ key, message: { conversation: 'hi' }, messageTimestamp: 100 })).toMatchObject({ type: 'text', text: 'hi', timestamp: 100 });
    const ex = extract({ key, message: { extendedTextMessage: { text: 'look https://x.co', title: 'News story', contextInfo: { stanzaId: 'Q1', participant: 'me@s.whatsapp.net', mentionedJid: ['a@lid'] } } } });
    expect(ex).toMatchObject({ type: 'text', mediaDesc: 'News story', quotedId: 'Q1', quotedParticipant: 'me@s.whatsapp.net', mentionedJids: ['a@lid'] });
  });

  it('unwraps ephemeral and view-once messages', () => {
    const ex = extract({ key, message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'look' } } } } } } });
    expect(ex).toMatchObject({ type: 'image', text: 'look', needsMedia: true });
  });

  it('classifies media', () => {
    expect(extract({ key, message: { audioMessage: { ptt: true, seconds: 12 } } })).toMatchObject({ type: 'voice', needsMedia: true, seconds: 12 });
    expect(extract({ key, message: { audioMessage: { ptt: false } } })).toMatchObject({ type: 'audio', needsMedia: false });
    expect(extract({ key, message: { documentMessage: { fileName: 'invoice.pdf' } } })).toMatchObject({ type: 'document', mediaDesc: 'invoice.pdf' });
    expect(extract({ key, message: { stickerMessage: {} } })).toMatchObject({ type: 'sticker' });
    expect(extract({ key, message: { locationMessage: { name: 'Kotel' } } })).toMatchObject({ type: 'location', text: 'Kotel' });
  });

  it('handles reactions, revokes and edits', () => {
    expect(extract({ key, message: { reactionMessage: { text: '👍', key: { id: 'T' } } } })).toMatchObject({ type: 'reaction', text: '👍', quotedId: 'T' });
    expect(extract({ key, message: { reactionMessage: { text: '', key: { id: 'T' } } } })).toBeNull();
    expect(extract({ key, message: { protocolMessage: { type: 0, key: { id: 'T' } } } })?.protocol).toEqual({ kind: 'revoke', targetId: 'T' });
    expect(extract({ key, message: { protocolMessage: { type: 14, key: { id: 'T' }, editedMessage: { conversation: 'fixed' } } } })?.protocol)
      .toEqual({ kind: 'edit', targetId: 'T', text: 'fixed' });
  });

  it('skips empty and key-only messages', () => {
    expect(extract({ key, message: { senderKeyDistributionMessage: {} } })).toBeNull();
    expect(extract({ key: { remoteJid: 'x' }, message: { conversation: 'hi' } })).toBeNull();
  });
});

describe('filter', () => {
  const me = { pn: '972535551234@s.whatsapp.net', lid: '1234@lid' };

  it('matches me by phone JID (with device) or LID', () => {
    expect(isMe('972535551234:7@s.whatsapp.net', me)).toBe(true);
    expect(isMe('1234@lid', me)).toBe(true);
    expect(isMe('999@lid', me)).toBe(false);
    expect(bareJid('1:2@lid')).toBe('1@lid');
  });

  it('applies tiers', () => {
    const plain = { fromMe: false, mentionsMe: false, quotesMe: false };
    expect(shouldStore('muted', { ...plain, fromMe: true })).toBe(false);
    expect(shouldStore('mentions', plain)).toBe(false);
    expect(shouldStore('mentions', { ...plain, mentionsMe: true })).toBe(true);
    expect(shouldStore('mentions', { ...plain, quotesMe: true })).toBe(true);
    expect(shouldStore('normal', plain)).toBe(true);
    expect(isSupportedJid('status@broadcast')).toBe(false);
    expect(isSupportedJid('123@newsletter')).toBe(false);
  });
});

describe('phone', () => {
  it('normalizes Israeli and international numbers', () => {
    expect(normalizePhone('053-555-1234')).toBe('972535551234');
    expect(normalizePhone('+972 53 555 1234')).toBe('972535551234');
    expect(normalizePhone('0044 7700 900123')).toBe('447700900123');
    expect(callerFromSip('<sip:0535551234@1.2.3.4>;tag=x')).toBe('972535551234');
    expect(speakableNumber('972535551234@s.whatsapp.net')).toBe('053 555 1234');
  });
});
