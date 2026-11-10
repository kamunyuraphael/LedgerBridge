import { SaleRecord } from '../models/SaleRecord';

export interface OutboxItem {
  id: string;
  recordId: string;
  timestamp: Date;
  storeCode: string;
  sku: string;
  unitsSold: number;
  totalRevenueCents: number;
  attempts: number;
}

export interface FailureUpdate {
  attempts: number;
  error: string;
  failed: boolean;
  nextAttemptAt: Date;
}

/** Persistence boundary for the sync worker (MongoDB in production, in-memory in tests). */
export interface OutboxStore {
  reclaimStale(cutoff: Date): Promise<number>;
  /** Atomically moves ONE runnable pending record to "processing" and returns it. */
  claimNext(now: Date): Promise<OutboxItem | null>;
  markSynced(ids: string[], ledgerFile: string, at: Date): Promise<void>;
  markFailed(id: string, update: FailureUpdate): Promise<void>;
  countOpen(): Promise<number>;
}

export class MongoOutboxStore implements OutboxStore {
  async reclaimStale(cutoff: Date): Promise<number> {
    const res = await SaleRecord.updateMany(
      { syncStatus: 'processing', lockedAt: { $lt: cutoff } },
      { $set: { syncStatus: 'pending' }, $unset: { lockedAt: '' } },
    );
    return res.modifiedCount;
  }

  async claimNext(now: Date): Promise<OutboxItem | null> {
    const d = await SaleRecord.findOneAndUpdate(
      { syncStatus: 'pending', nextAttemptAt: { $lte: now } },
      { $set: { syncStatus: 'processing', lockedAt: now } },
      { sort: { timestamp: 1 }, returnDocument: 'after' },
    );
    if (!d) return null;
    return {
      id: String(d._id),
      recordId: d.recordId,
      timestamp: d.timestamp,
      storeCode: d.storeCode,
      sku: d.sku,
      unitsSold: d.unitsSold,
      totalRevenueCents: d.totalRevenueCents,
      attempts: d.attempts,
    };
  }

  async markSynced(ids: string[], ledgerFile: string, at: Date): Promise<void> {
    await SaleRecord.updateMany(
      { _id: { $in: ids } },
      {
        $set: { syncStatus: 'synced', syncedAt: at, ledgerFile },
        $unset: { lockedAt: '', lastError: '' },
      },
    );
  }

  async markFailed(id: string, u: FailureUpdate): Promise<void> {
    await SaleRecord.updateOne(
      { _id: id },
      {
        $set: {
          attempts: u.attempts,
          lastError: u.error.slice(0, 500),
          syncStatus: u.failed ? 'failed' : 'pending',
          nextAttemptAt: u.nextAttemptAt,
        },
        $unset: { lockedAt: '' },
      },
    );
  }

  async countOpen(): Promise<number> {
    return SaleRecord.countDocuments({ syncStatus: { $in: ['pending', 'processing'] } });
  }
}
