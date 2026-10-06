export interface Models {
  classify: string;
  summarize: string;
  vision: string;
  transcribe: string;
  call: string;
  simulate: string;
}

export interface Config {
  my_phone: string;
  pin: string;
  flagged: string[];
  muted: string[];
  whitelisted_groups: string[];
  dictation_marker: boolean;
  dictation_marker_text: string;
  restore_unread_after_send: boolean;
  call_voice: string;
  /** What to call people, keyed by number, JID or name: { "+1 847-555-0100": "Mom" }. */
  names: Record<string, string>;
  models: Models;
}

export const DEFAULT_MODELS: Models = {
  classify: 'gpt-6-luna',
  summarize: 'gpt-6-luna',
  vision: 'gpt-6-luna',
  transcribe: 'gpt-4o-mini-transcribe',
  call: 'gpt-realtime-2.1-mini',
  simulate: 'gpt-6-luna',
};

export const DEFAULT_CONFIG: Config = {
  my_phone: '',
  pin: '',
  flagged: [],
  muted: [],
  whitelisted_groups: [],
  dictation_marker: false,
  dictation_marker_text: '🎙️',
  restore_unread_after_send: true,
  call_voice: 'cedar',
  names: {},
  models: DEFAULT_MODELS,
};

export class ConfigError extends Error {}

const strList = (v: unknown, key: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${key} must be a list`);
  return v.map((x) => String(x).trim()).filter(Boolean);
};

function parseNames(v: unknown): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('names must be a mapping, e.g. "+1 847-555-0100": Mom');
  return Object.fromEntries(Object.entries(v).map(([k, n]) => [k.trim(), String(n).trim()]).filter(([k, n]) => k && n));
}

/** Validate a parsed YAML object, filling defaults. */
export function parseConfig(raw: unknown): Config {
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a mapping');
  const r = raw as Record<string, unknown>;
  // An unquoted 0123 is the number 123 in YAML: the leading zero would be lost.
  if (typeof r.pin === 'number') throw new ConfigError('pin must be quoted, e.g. pin: "0123"');
  const pin = r.pin == null ? '' : String(r.pin);
  if (pin && !/^\d{3,10}$/.test(pin)) throw new ConfigError('pin must be 3–10 digits');
  const models = (r.models ?? {}) as Record<string, unknown>;
  if (typeof models !== 'object') throw new ConfigError('models must be a mapping');
  return {
    my_phone: r.my_phone == null ? '' : String(r.my_phone),
    pin,
    flagged: strList(r.flagged, 'flagged'),
    muted: strList(r.muted, 'muted'),
    whitelisted_groups: strList(r.whitelisted_groups, 'whitelisted_groups'),
    dictation_marker: Boolean(r.dictation_marker ?? false),
    dictation_marker_text: String(r.dictation_marker_text ?? DEFAULT_CONFIG.dictation_marker_text),
    restore_unread_after_send: Boolean(r.restore_unread_after_send ?? true),
    call_voice: String(r.call_voice ?? DEFAULT_CONFIG.call_voice),
    names: parseNames(r.names),
    models: Object.fromEntries(
      Object.entries(DEFAULT_MODELS).map(([k, v]) => [k, models[k] == null ? v : String(models[k])]),
    ) as unknown as Models,
  };
}
