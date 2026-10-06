// Seeds a throwaway database with a realistic inbox, for the simulator and tests.
import { writeFileSync } from 'node:fs';
import type { Store } from '../src/db/store.ts';
import type { NewMessage } from '../src/db/types.ts';

export const DEMO_CONFIG = `my_phone: "0535551234"
pin: "1234"
flagged:
  - Mom
muted:
  - Building committee
whitelisted_groups:
  - Family
`;

const P = (n: string) => `97250${n}@s.whatsapp.net`;
export const DEMO = {
  mom: P('1111111'), yossi: P('2222222'), dovidC: P('3333333'), dovidL: P('4444444'), sruli: P('5555555'),
  family: '120363000000000001@g.us', building: '120363000000000002@g.us', shiur: '120363000000000003@g.us',
  me: '972535551234@s.whatsapp.net',
};

export function seedDemo(store: Store, configFile: string, now: number) {
  writeFileSync(configFile, DEMO_CONFIG);
  store.upsertContact({ jid: DEMO.mom, name: 'Mom' });
  store.upsertContact({ jid: DEMO.yossi, name: 'Yossi Cohen', push_name: 'Yossi' });
  store.upsertContact({ jid: DEMO.dovidC, name: 'Dovid Cohen' });
  store.upsertContact({ jid: DEMO.dovidL, name: 'Dovid Levi' });
  store.upsertContact({ jid: DEMO.sruli, name: 'שרולי', push_name: 'Sruli' });
  store.upsertChat({ jid: DEMO.family, name: 'Family', is_group: true }, now);
  store.upsertChat({ jid: DEMO.building, name: 'Building committee', is_group: true }, now);
  store.upsertChat({ jid: DEMO.shiur, name: 'Shiur Beis', is_group: true }, now);

  let n = 0;
  const add = (chat: string, minsAgo: number, f: Partial<NewMessage> & { transcript?: string }) => {
    if (!store.getChat(chat)) store.upsertChat({ jid: chat }, now);
    const { transcript, ...rest } = f;
    const id = store.insertMessage({
      id: `demo${++n}`, chat_jid: chat, sender_jid: chat.endsWith('@g.us') ? DEMO.yossi : chat, sender_name: null,
      from_me: 0, type: 'text', raw_text: null, media_ref: null, is_urgent: 0, is_trivial: 0, quoted_id: null,
      mentions_me: 0, created_at: now - minsAgo * 60, ...rest,
    })!;
    if (transcript) store.updateMessage(id, { transcript });
  };

  add(DEMO.mom, 300, { raw_text: 'Hi sweetie, are you coming home for Sukkos?' });
  add(DEMO.mom, 290, { type: 'image', media_desc: 'the new sukkah decorations in the garden' });
  add(DEMO.mom, 280, { raw_text: 'Abba says to bring your tallis bag, he wants to fix the zipper' });
  add(DEMO.mom, 200, { from_me: 1, raw_text: 'Yes, Thursday night' });
  add(DEMO.mom, 100, { raw_text: '❤️', type: 'reaction', is_trivial: 1 });

  add(DEMO.dovidC, 30, { raw_text: 'Your car is blocking the ambulance entrance at the yeshiva, please move it now!!', is_urgent: 1 });

  add(DEMO.yossi, 600, { raw_text: 'Can I borrow your Ketzos for the week?' });
  add(DEMO.yossi, 590, { raw_text: 'I can pick it up Wednesday after maariv' });
  add(DEMO.yossi, 580, { raw_text: '👍', is_trivial: 1 });

  add(DEMO.sruli, 1500, { type: 'voice', transcript: 'היי, רציתי לשאול אם אתה בא לחתונה של מנחם ביום שלישי. תגיד לי עד מחר' });

  const fam = (minsAgo: number, sender: string, f: Partial<NewMessage>) => add(DEMO.family, minsAgo, { sender_jid: sender, ...f });
  fam(900, DEMO.mom, { raw_text: 'Who is bringing the salads for the first night?' });
  fam(880, DEMO.dovidL, { raw_text: 'We can do two salads and a kugel' });
  fam(870, DEMO.sruli, { type: 'image', media_desc: 'a baby in a high chair covered in honey cake' });
  fam(865, DEMO.sruli, { type: 'image', media_desc: 'the same baby laughing' });
  fam(860, DEMO.sruli, { type: 'image' });
  fam(855, DEMO.sruli, { type: 'image' });
  fam(850, DEMO.mom, { type: 'reaction', raw_text: '😂', is_trivial: 1 });

  add(DEMO.shiur, 120, { raw_text: '@you are you giving the chabura tomorrow?', mentions_me: 1 });
  add(DEMO.dovidL, 2000, { type: 'document', media_desc: 'chabura-sources.pdf' });
}
