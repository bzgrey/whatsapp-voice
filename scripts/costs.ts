// Month-to-date API spend from the usage table: npm run costs
import { openDb } from '../src/db/index.ts';
import { Store } from '../src/db/store.ts';
import { env } from '../src/env.ts';
import { monthToDate } from '../src/llm/usage.ts';

const { month, total_usd, by } = monthToDate(new Store(openDb(env.DB_PATH)));
console.log(`${month}: $${total_usd.toFixed(2)} (target ~$12/month incl. ~$7 VPS)`);
for (const r of by) console.log(`  ${r.purpose.padEnd(16)} ${r.model.padEnd(24)} ${String(r.calls).padStart(6)} calls  $${r.cost_usd.toFixed(4)}`);
