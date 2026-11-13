import type { Env } from '../config/env';
import { MongoTokenCacheStore } from '../models/TokenCache';
import { GraphHttpClient } from './graph/graphHttpClient';
import { MockDriveClient } from './graph/mockDriveClient';
import { ClientCredentialTokenProvider, DelegatedTokenProvider } from './graph/tokenProviders';
import type { DriveClient } from './graph/types';
import { GoogleSheetsLedger, GoogleTokenProvider, SheetsRestApi, parseServiceAccountJson } from './googleSheetsLedger';
import { LedgerService, type LedgerSink } from './ledgerWorkbook';
import { MongoOutboxStore } from './outboxStore';
import { GoogleSheetsOrderLedger } from './orderLedger';
import { MongoOrderLedgerStore, OrderLedgerWorker } from './orderLedgerWorker';
import { SyncWorker } from './syncWorker';

/** Delegated token provider for a free personal OneDrive (also used by the sign-in script). */
export function createOneDriveTokens(env: Env): DelegatedTokenProvider {
  return new DelegatedTokenProvider(env.AZURE_CLIENT_ID!, new MongoTokenCacheStore(env.TOKEN_ENCRYPTION_KEY!));
}

function buildSink(env: Env): { sink: LedgerSink; mockDrive?: MockDriveClient } {
  if (env.GRAPH_MODE === 'sheets') {
    const sa = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64!);
    const api = new SheetsRestApi(env.GOOGLE_SHEET_ID!, new GoogleTokenProvider(sa));
    return { sink: new GoogleSheetsLedger(api, env.LEDGER_CURRENCY) };
  }

  let drive: DriveClient;
  let mockDrive: MockDriveClient | undefined;
  if (env.GRAPH_MODE === 'live') {
    drive = new GraphHttpClient({
      rootPrefix: `/sites/${env.SP_SITE_ID!}/drives/${env.SP_DRIVE_ID!}/root:`,
      tokens: new ClientCredentialTokenProvider({
        tenantId: env.AZURE_TENANT_ID!,
        clientId: env.AZURE_CLIENT_ID!,
        clientSecret: env.AZURE_CLIENT_SECRET!,
      }),
    });
  } else if (env.GRAPH_MODE === 'onedrive') {
    drive = new GraphHttpClient({ rootPrefix: '/me/drive/root:', tokens: createOneDriveTokens(env) });
  } else {
    mockDrive = new MockDriveClient();
    drive = mockDrive;
  }
  return { sink: new LedgerService(drive, 4, env.LEDGER_CURRENCY), ...(mockDrive ? { mockDrive } : {}) };
}

/** Approved-orders ledger worker. Only runs with a Google Sheet (GRAPH_MODE=sheets); otherwise orders just queue up. */
function buildOrderLedgerWorker(env: Env): OrderLedgerWorker | undefined {
  if (env.GRAPH_MODE !== 'sheets') return undefined;
  const sa = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64!);
  const api = new SheetsRestApi(env.GOOGLE_SHEET_ID!, new GoogleTokenProvider(sa));
  return new OrderLedgerWorker(new MongoOrderLedgerStore(), new GoogleSheetsOrderLedger(api), {
    pollMs: env.SYNC_POLL_MS,
    maxAttempts: env.SYNC_MAX_ATTEMPTS,
    backoffBaseMs: env.SYNC_BACKOFF_BASE_MS,
    lockTimeoutMs: env.SYNC_LOCK_TIMEOUT_MS,
    tabPrefix: env.ORDER_LEDGER_PREFIX,
  });
}

export function buildPipeline(env: Env): { mockDrive?: MockDriveClient; worker: SyncWorker; orderLedger?: OrderLedgerWorker } {
  const { sink, mockDrive } = buildSink(env);
  const worker = new SyncWorker(new MongoOutboxStore(), sink, {
    pollMs: env.SYNC_POLL_MS,
    batchSize: env.SYNC_BATCH_SIZE,
    maxAttempts: env.SYNC_MAX_ATTEMPTS,
    backoffBaseMs: env.SYNC_BACKOFF_BASE_MS,
    lockTimeoutMs: env.SYNC_LOCK_TIMEOUT_MS,
    folderPath: env.SP_FOLDER_PATH,
    filePrefix: env.LEDGER_FILE_PREFIX,
    rollover: env.LEDGER_ROLLOVER,
  });
  const orderLedger = buildOrderLedgerWorker(env);
  return { ...(mockDrive ? { mockDrive } : {}), worker, ...(orderLedger ? { orderLedger } : {}) };
}
