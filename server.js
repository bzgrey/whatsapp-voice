import express from 'express';
import { startWhatsApp, listGroups } from './whatsapp.js';
import { getUnheard } from './db.js';

const app = express();
app.use(express.json());

// Phase 1: just prove ingestion + storage work.
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/unheard', (_req, res) => res.json(getUnheard()));
app.get('/groups', async (_req, res) => res.json(await listGroups()));

// Phase 3 will add: POST /webhook (realtime.call.incoming -> accept -> control WebSocket).

startWhatsApp({
  // Phase 3+: trigger outbound call here.
  onUrgent: (m) => console.log('TODO outbound call for urgent message from', m.sender_name),
});

app.listen(process.env.PORT || 3000, () => console.log('listening on', process.env.PORT || 3000));
