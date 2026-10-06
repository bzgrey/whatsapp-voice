/**
 * Metadata-only logging (SPEC §10.8): chat names, counts, errors, costs.
 * Never pass message text here.
 */
const stamp = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(stamp(), ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), 'WARN', ...a),
  error: (...a: unknown[]) => console.error(stamp(), 'ERROR', ...a),
};

/**
 * libsignal (inside Baileys) console-logs whole session records, key material
 * included, on routine session changes. Drop those lines.
 */
export function silenceLibsignal() {
  const noisy = /^(Closing session|Closing open session|Opening session|Removing old closed session|Session already|Migrating session|Decrypted message with closed session|Failed to decrypt message with any known session|Session error|Unhandled bucket type)/;
  for (const level of ['info', 'warn', 'error', 'log'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => { if (!(typeof a[0] === 'string' && noisy.test(a[0]))) orig(...a); };
  }
}

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
