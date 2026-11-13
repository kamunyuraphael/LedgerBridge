import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { Env } from './config/env';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { catalogueRouter } from './routes/catalogue';
import { ordersRouter } from './routes/orders';
import { salesRouter } from './routes/sales';
import { HttpError } from './services/orderService';
import type { MockDriveClient } from './services/graph/mockDriveClient';
import type { SyncWorker } from './services/syncWorker';
import { logger } from './utils/logger';

export interface AppDeps {
  env: Env;
  worker: SyncWorker;
  /** Present only in GRAPH_MODE=mock; exposes the fake ledger for local inspection. */
  mockDrive?: MockDriveClient;
}

export function createApp({ env, worker, mockDrive }: AppDeps): express.Express {
  const app = express();
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()) }));
  // Admin imports send a raw .xlsx body, so JSON parsing must skip that path.
  const json = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/admin/import/') ? next() : json(req, res, next)));

  app.get('/api/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp, graphMode: env.GRAPH_MODE });
  });

  app.use('/api/auth', authRouter(env));
  app.use('/api/catalogue', catalogueRouter(env));
  app.use('/api/orders', ordersRouter(env));
  app.use('/api/admin', adminRouter(env));
  // Legacy sales-ledger module from the first prototype (kept for now; ledger sync will move to approved orders).
  app.use('/api/sales', salesRouter(worker, env.ADMIN_API_KEY));

  if (mockDrive && env.NODE_ENV !== 'production') {
    app.get('/api/dev/mock-ledger', (req, res) => {
      const file = typeof req.query.file === 'string' ? req.query.file : undefined;
      if (!file) {
        res.json({ files: mockDrive.listFiles() });
        return;
      }
      const data = mockDrive.getFile(file);
      if (!data) {
        res.status(404).json({ error: 'not_found', files: mockDrive.listFiles() });
        return;
      }
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .set('Content-Disposition', 'attachment; filename="ledger.xlsx"')
        .send(data);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    logger.error('http.unhandled', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);

  return app;
}
