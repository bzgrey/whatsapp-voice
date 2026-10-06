/**
 * Normalize a phone number to international digits, assuming Israel for local numbers:
 * "053-555-1234" → "972535551234", "+44 7700 900123" → "447700900123".
 */
export function normalizePhone(input: string): string {
  let d = input.replace(/^sips?:/, '').split('@')[0]!.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}

export const phoneToJid = (phone: string) => `${normalizePhone(phone)}@s.whatsapp.net`;

/** Digits of a phone JID, e.g. "972535551234@s.whatsapp.net" → "972535551234"; null for groups/LIDs. */
export function jidPhone(jid: string): string | null {
  const m = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return m ? m[1]! : null;
}

/** Speakable local form of a phone JID: "972535551234@…" → "053 555 1234". */
export function speakableNumber(jid: string): string {
  const d = jidPhone(jid);
  if (!d) return 'an unknown number';
  const local = d.startsWith('972') ? '0' + d.slice(3) : '+' + d;
  return local.replace(/^(\+?\d{3})(\d{3})(\d+)$/, '$1 $2 $3');
}

/** Pull the caller's number out of a SIP From header or URI. */
export function callerFromSip(from: string | undefined): string | null {
  if (!from) return null;
  const m = /sips?:(\+?[\d-]+)@/.exec(from) ?? /^(\+?[\d-]{6,})$/.exec(from.trim());
  return m ? normalizePhone(m[1]!) : null;
}
