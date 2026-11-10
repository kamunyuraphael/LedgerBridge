import { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { SaleRecord } from '../models/SaleRecord';
import { fromCents, saleInputSchema, toCents } from '../schemas/sale';
import type { SyncWorker } from '../services/syncWorker';

type Doc = InstanceType<typeof SaleRecord>;

const present = (d: Doc) => ({
  recordId: d.recordId,
  storeCode: d.storeCode,
  sku: d.sku,
  unitsSold: d.unitsSold,
  totalRevenue: fromCents(d.totalRevenueCents),
  timestamp: d.timestamp.toISOString(),
  syncStatus: d.syncStatus,
  attempts: d.attempts,
  lastError: d.syncStatus === 'failed' ? d.lastError : undefined,
  syncedAt: d.syncedAt?.toISOString(),
  ledgerFile: d.ledgerFile,
});

export function salesRouter(worker: SyncWorker, adminApiKey: string | undefined): Router {
  const router = Router();

  const submitLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many submissions, slow down.' },
  });

  const requireAdmin: RequestHandler = (req: Request, res, next) => {
    if (!adminApiKey || req.header('x-api-key') !== adminApiKey) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  router.post('/', submitLimiter, async (req, res) => {
    const parsed = saleInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const { recordId, storeCode, sku, unitsSold, totalRevenue, clientSubmittedAt } = parsed.data;

    try {
      // 1) MongoDB first (source of truth). Server stamps the timestamp.
      const doc = await SaleRecord.create({
        ...(recordId ? { recordId } : {}),
        storeCode,
        sku,
        unitsSold,
        totalRevenueCents: toCents(totalRevenue),
        timestamp: new Date(),
        ...(clientSubmittedAt ? { clientSubmittedAt: new Date(clientSubmittedAt) } : {}),
      });
      // 2) Fire-and-forget: the SharePoint push happens in the background worker.
      void worker.kick();
      res.status(202).json(present(doc));
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000 && recordId) {
        // Idempotent replay (double-click / network retry): return the original record.
        const existing = await SaleRecord.findOne({ recordId });
        if (existing) {
          res.status(200).json(present(existing));
          return;
        }
      }
      throw err;
    }
  });

  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const docs = await SaleRecord.find().sort({ timestamp: -1 }).limit(limit);
    res.json(docs.map(present));
  });

  router.get('/:recordId', async (req, res) => {
    const doc = await SaleRecord.findOne({ recordId: req.params.recordId });
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(present(doc));
  });

  /** Admin: re-queue ALL failed records (e.g. after re-authenticating or fixing the ledger file). */
  router.post('/retry-failed', requireAdmin, async (_req, res) => {
    const result = await SaleRecord.updateMany(
      { syncStatus: 'failed' },
      { $set: { syncStatus: 'pending', attempts: 0, nextAttemptAt: new Date() }, $unset: { lastError: '' } },
    );
    void worker.kick();
    res.json({ requeued: result.modifiedCount });
  });

  /** Admin: re-queue a failed record. */
  router.post('/:recordId/retry', requireAdmin, async (req, res) => {
    const doc = await SaleRecord.findOneAndUpdate(
      { recordId: req.params.recordId, syncStatus: 'failed' },
      { $set: { syncStatus: 'pending', attempts: 0, nextAttemptAt: new Date() }, $unset: { lastError: '' } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      res.status(404).json({ error: 'not_found_or_not_failed' });
      return;
    }
    void worker.kick();
    res.json(present(doc));
  });

  return router;
}
