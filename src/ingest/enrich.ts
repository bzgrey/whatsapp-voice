import type { Store } from '../db/store.ts';
import type { JobRow } from '../db/types.ts';
import { displayName } from '../config/names.ts';
import { messageContent } from '../briefing/render.ts';
import type { Tasks } from '../llm/tasks.ts';
import type { JobResult } from './jobs.ts';
import { refreshSummaryLine } from './summaries.ts';

/** Downloads a message's media into memory (nothing is written to disk). */
export interface MediaFetcher {
  download(mediaRef: string): Promise<{ buffer: Buffer; mime: string; seconds: number | null }>;
}

/** Give up waiting for a chat's media before summarizing after this long. */
const SUMMARY_WAIT_SECONDS = 600;

/** Job handlers: transcription, image description, classification, chat summaries. */
export class Enricher {
  constructor(private store: Store, private tasks: Tasks, private media: MediaFetcher | null, private now: () => number) {}

  run = async (job: JobRow): Promise<JobResult> => {
    if (job.kind === 'summarize') return this.summarize(job);
    const msg = this.store.getMessage(Number(job.ref));
    if (!msg) return 'done'; // purged or deleted meanwhile
    const now = this.now();

    switch (job.kind) {
      case 'transcribe': {
        const transcript = msg.media_ref ? await this.transcribe(msg.media_ref) : null;
        this.store.updateMessage(msg.rowid, { transcript, media_ref: null });
        this.store.enqueue('classify', msg.rowid, now, now);
        return 'done';
      }
      case 'describe': {
        const desc = msg.media_ref ? await this.describe(msg.media_ref, msg.raw_text) : null;
        this.store.updateMessage(msg.rowid, { media_desc: desc || null, media_ref: null });
        this.store.enqueue('classify', msg.rowid, now, now);
        return 'done';
      }
      case 'classify': {
        const chat = this.store.getChat(msg.chat_jid);
        const c = await this.tasks.classify(messageContent(msg), { chat: displayName(this.store, msg.chat_jid), isGroup: !!chat?.is_group });
        this.store.updateMessage(msg.rowid, { is_urgent: c.is_urgent ? 1 : 0, is_trivial: c.is_trivial ? 1 : 0 });
        return 'done';
      }
    }
    return 'done';
  };

  private async transcribe(ref: string) {
    if (!this.media) throw new Error('no media fetcher');
    const { buffer, seconds } = await this.media.download(ref);
    return this.tasks.transcribe(buffer, 'voice.ogg', seconds ?? 30);
  }

  private async describe(ref: string, caption: string | null) {
    if (!this.media) throw new Error('no media fetcher');
    const { buffer, mime } = await this.media.download(ref);
    return this.tasks.describeImage(buffer, mime, caption);
  }

  /** Wait for the chat's media and classification to finish, then rebuild its one-liner. */
  private async summarize(job: JobRow): Promise<JobResult> {
    const now = this.now();
    const unheard = this.store.unheardForChat(job.ref);
    const pending = unheard.some((m) => m.media_ref !== null || m.is_trivial === null);
    if (pending && now - job.created_at < SUMMARY_WAIT_SECONDS) return { deferSeconds: 30 };
    await refreshSummaryLine(this.store, this.tasks, job.ref, now);
    return 'done';
  }
}
