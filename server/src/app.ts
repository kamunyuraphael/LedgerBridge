import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { Env } from './config/env';
import { salesRouter } from './routes/sales';
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
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp, graphMode: env.GRAPH_MODE });
  });

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
    logger.error('http.unhandled', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);

  return app;
}
