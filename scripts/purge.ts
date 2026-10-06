// Delete everything older than 4 days now (the server also does this hourly): npm run purge
import { openDb } from '../src/db/index.ts';
import { Store } from '../src/db/store.ts';
import { env, nowSec, RETENTION_SECONDS } from '../src/env.ts';

const n = new Store(openDb(env.DB_PATH)).purgeBefore(nowSec() - RETENTION_SECONDS);
console.log(`deleted ${n} messages older than 4 days`);
