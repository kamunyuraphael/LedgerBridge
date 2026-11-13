import mongoose from 'mongoose';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { buildPipeline } from './services/buildPipeline';
import { seedIfEmpty } from './services/seed';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI);
  logger.info('mongo.connected');
  await seedIfEmpty(env);

  const { worker, mockDrive, orderLedger } = buildPipeline(env);
  const app = createApp({ env, worker, ...(mockDrive ? { mockDrive } : {}) });
  worker.start();
  if (orderLedger) orderLedger.start();
  else logger.info('orders.ledger_disabled', { hint: 'Set GRAPH_MODE=sheets to copy approved orders to a Google Sheet' });

  const server = app.listen(env.PORT, () =>
    logger.info('server.listening', { port: env.PORT, graphMode: env.GRAPH_MODE }),
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('server.shutdown', { signal });
    server.close();
    await worker.stop();
    await orderLedger?.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('server.fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
