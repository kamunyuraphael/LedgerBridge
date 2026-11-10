import { fromCents } from '../schemas/sale';
import { GraphError } from './graph/types';
import type { LedgerRow, LedgerSink } from './ledgerWorkbook';
import type { OutboxItem, OutboxStore } from './outboxStore';
import { logger } from '../utils/logger';

export interface SyncWorkerOptions {
  pollMs: number;
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  lockTimeoutMs: number;
  folderPath: string;
  filePrefix: string;
  rollover: 'monthly' | 'none';
}

type Claimed = OutboxItem;

/**
 * Outbox worker: claims pending MongoDB records and pushes them to the SharePoint ledger.
 *  - Mongo is the source of truth; the worker only ever moves rows forward.
 *  - One tick at a time per process (in-process mutex) + atomic Mongo claims across processes.
 *  - Each tick drains a whole batch per ledger file: one download, N rows, one upload.
 */
export class SyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly ledger: LedgerSink,
    private readonly opts: SyncWorkerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.kick(), this.opts.pollMs);
    this.timer.unref();
    void this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  /** Request a drain now. Calls made while a tick is running are coalesced into one follow-up tick. */
  async kick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.tick();
      } while (this.rerun && !this.stopped);
    } catch (err) {
      logger.error('sync.tick_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }

  /** Resolves when the queue has nothing runnable left (test helper). */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.kick();
      while (this.running) await new Promise((r) => setTimeout(r, 10));
      const open = await this.store.countOpen();
      if (open === 0) return;
      if (Date.now() > deadline) throw new Error(`drain timed out with ${open} records still open`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private fileFor(ts: Date): string {
    const name =
      this.opts.rollover === 'monthly'
        ? `${this.opts.filePrefix}_${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, '0')}.xlsx`
        : `${this.opts.filePrefix}.xlsx`;
    return [this.opts.folderPath.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');
  }

  private async reclaimStale(): Promise<void> {
    const cutoff = new Date(Date.now() - this.opts.lockTimeoutMs);
    const count = await this.store.reclaimStale(cutoff);
    if (count) logger.warn('sync.reclaimed_stale', { count });
  }

  private async claimBatch(): Promise<Claimed[]> {
    const claimed: Claimed[] = [];
    while (claimed.length < this.opts.batchSize) {
      const doc = await this.store.claimNext(new Date());
      if (!doc) break;
      claimed.push(doc);
    }
    return claimed;
  }

  private async tick(): Promise<void> {
    await this.reclaimStale();
    for (;;) {
      const batch = await this.claimBatch();
      if (batch.length === 0) return;

      const byFile = new Map<string, Claimed[]>();
      for (const doc of batch) {
        const file = this.fileFor(doc.timestamp);
        byFile.set(file, [...(byFile.get(file) ?? []), doc]);
      }
      for (const [file, docs] of byFile) await this.pushGroup(file, docs);
      if (batch.length < this.opts.batchSize) return;
    }
  }

  private async pushGroup(file: string, docs: Claimed[]): Promise<void> {
    const rows: LedgerRow[] = docs.map((d) => ({
      recordId: d.recordId,
      timestamp: d.timestamp,
      storeCode: d.storeCode,
      sku: d.sku,
      unitsSold: d.unitsSold,
      totalRevenue: fromCents(d.totalRevenueCents),
    }));
    const ids = docs.map((d) => d.id);
    try {
      const result = await this.ledger.append(file, rows);
      await this.store.markSynced(ids, file, new Date());
      logger.info('sync.group_ok', { file, ...result, records: docs.length });
    } catch (err) {
      await this.handleFailure(docs, err, file);
    }
  }

  private async handleFailure(docs: Claimed[], err: unknown, file: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof GraphError ? err.retryable : true;
    const retryAfterMs = err instanceof GraphError ? err.retryAfterMs : undefined;

    for (const doc of docs) {
      const attempts = doc.attempts + 1;
      const exhausted = !retryable || attempts >= this.opts.maxAttempts;
      const delay = Math.max(this.backoff(attempts), retryAfterMs ?? 0);
      await this.store.markFailed(doc.id, {
        attempts,
        error: message,
        failed: exhausted,
        nextAttemptAt: new Date(Date.now() + delay),
      });
    }
    logger.error('sync.group_failed', {
      file,
      records: docs.length,
      retryable,
      error: message,
      recordIds: docs.map((d) => d.recordId),
    });
  }

  /** Exponential backoff with +/-20% jitter, capped at 15 minutes. */
  private backoff(attempts: number): number {
    const base = Math.min(this.opts.backoffBaseMs * 2 ** (attempts - 1), 15 * 60_000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }
}
