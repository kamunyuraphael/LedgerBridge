import { Order } from '../models/Order';
import { GraphError } from './graph/types';
import { orderTabFor, type OrderLedgerRow, type OrderLedgerSink } from './orderLedger';
import type { OrderStatus } from './orderLogic';
import { logger } from '../utils/logger';

export interface LedgerJob extends OrderLedgerRow {
  id: string;
  rev: number;
  attempts: number;
}
export interface LedgerFailure {
  attempts: number;
  error: string;
  failed: boolean;
  nextAt: Date;
}

/** Persistence boundary for the order-ledger worker (MongoDB in production, in-memory in tests). */
export interface OrderLedgerStore {
  reclaimStale(cutoff: Date): Promise<number>;
  claimNext(now: Date): Promise<LedgerJob | null>;
  markSynced(job: LedgerJob, at: Date): Promise<void>;
  markFailed(job: LedgerJob, f: LedgerFailure): Promise<void>;
  countOpen(): Promise<number>;
}

export class MongoOrderLedgerStore implements OrderLedgerStore {
  async reclaimStale(cutoff: Date): Promise<number> {
    const r = await Order.updateMany(
      { ledgerStatus: 'processing', ledgerLockedAt: { $lt: cutoff } },
      { $set: { ledgerStatus: 'pending' }, $unset: { ledgerLockedAt: '' } },
    );
    return r.modifiedCount;
  }

  async claimNext(now: Date): Promise<LedgerJob | null> {
    const d = await Order.findOneAndUpdate(
      { ledgerStatus: 'pending', ledgerNextAt: { $lte: now } },
      { $set: { ledgerStatus: 'processing', ledgerLockedAt: now } },
      { sort: { approvedAt: 1 }, returnDocument: 'after' },
    ).lean();
    if (!d) return null;
    return {
      id: String(d._id),
      rev: d.ledgerRev ?? 0,
      attempts: d.ledgerAttempts ?? 0,
      orderNo: d.orderNo,
      approvedAt: d.approvedAt ?? d.createdAt,
      ...(d.poNumber ? { poNumber: d.poNumber } : {}),
      branchName: d.branchName,
      supplierName: d.supplierName,
      status: d.status as OrderStatus,
    };
  }

  async markSynced(job: LedgerJob, at: Date): Promise<void> {
    // Only if nothing changed the order while we were writing; otherwise it stays queued for another pass.
    await Order.updateOne(
      { _id: job.id, ledgerRev: job.rev },
      { $set: { ledgerStatus: 'synced', ledgerSyncedAt: at, ledgerAttempts: 0 }, $unset: { ledgerLockedAt: '', ledgerError: '' } },
    );
  }

  async markFailed(job: LedgerJob, f: LedgerFailure): Promise<void> {
    await Order.updateOne(
      { _id: job.id, ledgerRev: job.rev },
      {
        $set: { ledgerStatus: f.failed ? 'failed' : 'pending', ledgerAttempts: f.attempts, ledgerError: f.error.slice(0, 500), ledgerNextAt: f.nextAt },
        $unset: { ledgerLockedAt: '' },
      },
    );
  }

  async countOpen(): Promise<number> {
    return Order.countDocuments({ ledgerStatus: { $in: ['pending', 'processing'] } });
  }
}

/** Re-queue every order whose ledger sync gave up (admin "retry" button). */
export async function requeueFailedLedger(): Promise<number> {
  const r = await Order.updateMany(
    { ledgerStatus: 'failed' },
    { $set: { ledgerStatus: 'pending', ledgerAttempts: 0, ledgerNextAt: new Date() }, $inc: { ledgerRev: 1 } },
  );
  return r.modifiedCount;
}

export interface OrderLedgerWorkerOptions {
  pollMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  lockTimeoutMs: number;
  tabPrefix: string;
}

/** Pushes approved orders (and later PO/status changes) to the order ledger, one order at a time. */
export class OrderLedgerWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly store: OrderLedgerStore,
    private readonly sink: OrderLedgerSink,
    private readonly opts: OrderLedgerWorkerOptions,
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
      logger.error('orders.ledger_tick_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }

  /** Resolves once nothing runnable is left (test helper). */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.kick();
      while (this.running) await new Promise((r) => setTimeout(r, 10));
      if ((await this.store.countOpen()) === 0) return;
      if (Date.now() > deadline) throw new Error('order ledger drain timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async tick(): Promise<void> {
    const stale = await this.store.reclaimStale(new Date(Date.now() - this.opts.lockTimeoutMs));
    if (stale) logger.warn('orders.ledger_reclaimed_stale', { count: stale });
    while (!this.stopped) {
      const job = await this.store.claimNext(new Date());
      if (!job) return;
      await this.push(job);
    }
  }

  private async push(job: LedgerJob): Promise<void> {
    const tab = orderTabFor(this.opts.tabPrefix, job.approvedAt);
    try {
      const r = await this.sink.sync(tab, job);
      await this.store.markSynced(job, new Date());
      logger.info('orders.ledger_ok', { orderNo: job.orderNo, tab, ...r });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof GraphError ? err.retryable : true;
      const retryAfterMs = err instanceof GraphError ? err.retryAfterMs : undefined;
      const attempts = job.attempts + 1;
      const base = Math.min(this.opts.backoffBaseMs * 2 ** (attempts - 1), 15 * 60_000);
      const delay = Math.max(Math.round(base * (0.8 + Math.random() * 0.4)), retryAfterMs ?? 0);
      await this.store.markFailed(job, {
        attempts,
        error: message,
        failed: !retryable || attempts >= this.opts.maxAttempts,
        nextAt: new Date(Date.now() + delay),
      });
      logger.error('orders.ledger_failed', { orderNo: job.orderNo, attempts, retryable, error: message });
    }
  }
}
