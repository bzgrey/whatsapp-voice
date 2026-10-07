import express from 'express';
import { ConfigSync } from './config/sync.ts';
import { openDb } from './db/index.ts';
import { Store } from './db/store.ts';
import { env, nowSec, RETENTION_SECONDS, STALE_SECONDS } from './env.ts';
import { Enricher } from './ingest/enrich.ts';
import { Ingest } from './ingest/ingest.ts';
import { JobWorker } from './ingest/jobs.ts';
import { LLM } from './llm/openai.ts';
import { Tasks } from './llm/tasks.ts';
import { errMsg, log, silenceLibsignal } from './log.ts';
import { WhatsApp } from './whatsapp/socket.ts';
import { getWaStatus } from './whatsapp/status.ts';
import { callRouter } from './call/webhook.ts';
import { monthToDate } from './llm/usage.ts';

silenceLibsignal();
const store = new Store(openDb(env.DB_PATH));
const config = new ConfigSync(store, env.CONFIG_PATH);
config.load();
config.watch();

const tasks = new Tasks(new LLM(store), () => config.config.models);
if (!tasks.llm.available) log.warn('OPENAI_API_KEY not set: enrichment jobs will fail and retry');

let wa: WhatsApp;
const ingest = new Ingest(store, config, () => wa.me, nowSec);
wa = new WhatsApp({ store, config, ingest, authDir: env.AUTH_DIR, pairingPhone: env.PAIRING_PHONE, now: nowSec });

const worker = new JobWorker(store, new Enricher(store, tasks, wa, nowSec).run, nowSec);

function purge() {
  const n = store.purgeBefore(nowSec() - RETENTION_SECONDS);
  if (n) log.info(`purge: deleted ${n} messages older than 4 days`);
  const stale = store.markHeardBefore(nowSec() - STALE_SECONDS, nowSec());
  if (stale) log.info(`purge: ${stale} messages older than 2 days assumed seen`);
}

const app = express();
// The call webhook needs the raw body for its signature, so it goes before express.json().
app.use(callRouter({ store, config, tasks, sender: wa, now: nowSec }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: getWaStatus(store), pendingJobs: store.pendingJobCount(), contacts: store.contactCounts() }));
app.get('/costs', (_req, res) => res.json(monthToDate(store)));
app.get('/groups', async (_req, res) => {
  try { res.json(await wa.listGroups()); } catch (err) { res.status(503).json({ error: errMsg(err) }); }
});

purge();
setInterval(purge, 3600_000);
worker.start();
await wa.start();
app.listen(env.PORT, '127.0.0.1', () => log.info(`listening on ${env.PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig}: shutting down`);
    worker.stop();
    config.stop();
    wa.stop();
    store.db.close();
    process.exit(0);
  });
}
