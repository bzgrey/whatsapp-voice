import type { Store } from '../db/store.ts';

/** Month-to-date spend from the usage table (Israel time month). */
export function monthToDate(store: Store, now = new Date()) {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(now);
  const start = Math.floor(new Date(`${ym}-01T00:00:00+03:00`).getTime() / 1000);
  const rows = store.usageSince(start);
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  return { month: ym, total_usd: Math.round(total * 10000) / 10000, by: rows };
}
