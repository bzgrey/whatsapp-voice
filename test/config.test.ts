import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDirectory, resolveExact, resolveSpoken } from '../src/config/resolve.ts';
import { computeTier } from '../src/config/sync.ts';
import { parseConfig } from '../src/config/schema.ts';
import { BUILDING, CONFIG, DOVID_C, FAMILY, makeConfig, makeStore, MOM, NOW, seedPeople, SHIUR, YOSSI } from './helpers.ts';

describe('name resolution', () => {
  const store = makeStore();
  seedPeople(store);
  const dir = buildDirectory(store);

  it('resolves exact names, numbers and JIDs', () => {
    expect(resolveExact(dir, 'mom')).toMatchObject({ status: 'ok', entry: { jid: MOM } });
    expect(resolveExact(dir, 'Yossi')).toMatchObject({ status: 'ok', entry: { jid: YOSSI } }); // push name
    expect(resolveExact(dir, '050-333-3333')).toMatchObject({ status: 'ok', entry: { jid: DOVID_C } });
    expect(resolveExact(dir, FAMILY)).toMatchObject({ status: 'ok', entry: { jid: FAMILY } });
    expect(resolveExact(dir, 'Dovid').status).toBe('unknown');
    // Numbers and JIDs apply before that chat has ever been seen.
    expect(resolveExact(dir, '+1 847-555-0199')).toMatchObject({ status: 'ok', entry: { jid: '18475550199@s.whatsapp.net' } });
    expect(resolveExact(dir, '120363999@g.us', 'group')).toMatchObject({ status: 'ok', entry: { jid: '120363999@g.us' } });
    expect(resolveExact(dir, 'Family', 'person').status).toBe('unknown');
  });

  it('resolves spoken names loosely, reporting ambiguity', () => {
    expect(resolveSpoken(dir, 'yossi cohen')).toMatchObject({ status: 'ok', entry: { jid: YOSSI } });
    expect(resolveSpoken(dir, 'the shiur group')).toMatchObject({ status: 'ok', entry: { jid: SHIUR } });
    const r = resolveSpoken(dir, 'Dovid');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.matches).toHaveLength(2);
  });

  it('flags an exact name shared by two contacts as ambiguous', () => {
    const s = makeStore();
    s.upsertContact({ jid: '1@s.whatsapp.net', name: 'Avi' });
    s.upsertContact({ jid: '2@s.whatsapp.net', name: 'Avi' });
    expect(resolveExact(buildDirectory(s), 'Avi').status).toBe('ambiguous');
  });
});

describe('config', () => {
  it('validates', () => {
    expect(parseConfig({ pin: '0123' }).pin).toBe('0123');
    expect(() => parseConfig({ pin: 123 })).toThrow(/quoted/);
    expect(() => parseConfig({ pin: '12a' })).toThrow();
    expect(parseConfig(null).models.classify).toBe('gpt-6-luna');
  });

  it('computes tiers', () => {
    const r = { flagged: new Set([MOM]), muted: new Set([BUILDING]), whitelisted: new Set([FAMILY]) };
    expect(computeTier({ jid: MOM, is_group: 0, archived: 0 }, r)).toBe('flagged');
    expect(computeTier({ jid: MOM, is_group: 0, archived: 1 }, r)).toBe('muted');
    expect(computeTier({ jid: YOSSI, is_group: 0, archived: 0 }, r)).toBe('normal');
    expect(computeTier({ jid: FAMILY, is_group: 1, archived: 0 }, r)).toBe('normal');
    expect(computeTier({ jid: SHIUR, is_group: 1, archived: 0 }, r)).toBe('mentions');
    expect(computeTier({ jid: BUILDING, is_group: 1, archived: 0 }, r)).toBe('muted');
  });

  it('applies the file to the DB and writes voice changes back, keeping comments', () => {
    const store = makeStore();
    seedPeople(store);
    store.upsertChat({ jid: MOM }, NOW);
    store.upsertChat({ jid: YOSSI }, NOW);
    const sync = makeConfig(store, CONFIG);
    expect(store.getChat(MOM)!.tier).toBe('flagged');
    expect(store.getChat(BUILDING)!.tier).toBe('muted');
    expect(store.getChat(SHIUR)!.tier).toBe('mentions');

    const yossi = buildDirectory(store).find((e) => e.jid === YOSSI)!;
    expect(sync.applyVoice(yossi, 'flag')).toMatch(/flagged/);
    expect(store.getChat(YOSSI)!.tier).toBe('flagged');
    const text = readFileSync(sync.file, 'utf8');
    expect(text).toContain('Yossi Cohen');
    expect(text).toContain('# my settings');

    const mom = buildDirectory(store).find((e) => e.jid === MOM)!;
    sync.applyVoice(mom, 'mute');
    expect(store.getChat(MOM)!.tier).toBe('muted');
    expect(sync.config.flagged).toEqual(['Yossi Cohen']);
    sync.applyVoice(mom, 'unmute');
    expect(store.getChat(MOM)!.tier).toBe('normal');
  });

  it('re-applies a hand edit', () => {
    const store = makeStore();
    seedPeople(store);
    store.upsertChat({ jid: YOSSI }, NOW);
    const sync = makeConfig(store, CONFIG);
    writeFileSync(sync.file, CONFIG.replace('  - Mom # always', '  - Yossi Cohen'));
    sync.load();
    expect(store.getChat(YOSSI)!.tier).toBe('flagged');
  });
});

describe('contacts', () => {
  it('routes a LID-addressed update to the phone-JID row', () => {
    const store = makeStore();
    store.upsertContact({ jid: YOSSI, lid: '77@lid', name: 'Yossi Cohen' });
    store.upsertContact({ jid: '77@lid', lid: '77@lid', push_name: 'Yossi C' });
    expect(store.allContacts()).toEqual([{ jid: YOSSI, lid: '77@lid', name: 'Yossi Cohen', push_name: 'Yossi C' }]);
    store.upsertContact({ jid: '88@lid', name: 'Only LID' });
    store.upsertContact({ jid: DOVID_C, lid: '88@lid' });
    expect(store.findContact('88@lid')).toMatchObject({ jid: DOVID_C, name: 'Only LID' });
  });
});
