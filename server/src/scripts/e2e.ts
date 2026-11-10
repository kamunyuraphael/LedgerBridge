/* Offline verification suite: no MongoDB or Azure needed (in-memory outbox + mock SharePoint). */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { loadEnv } from '../config/env';
import { saleInputSchema } from '../schemas/sale';
import { MockDriveClient } from '../services/graph/mockDriveClient';
import { GraphError } from '../services/graph/types';
import { LedgerService, SHEET_NAME, type LedgerRow } from '../services/ledgerWorkbook';
import type { FailureUpdate, OutboxItem, OutboxStore } from '../services/outboxStore';
import { mapError } from '../services/graph/graphHttpClient';
import { DelegatedTokenProvider, NOT_SIGNED_IN } from '../services/graph/tokenProviders';
import { decrypt, encrypt } from '../utils/crypto';
import {
  GoogleSheetsLedger, mapSheetsError, parseServiceAccountJson, tabNameFor, toSerialDate, type SheetsApi,
} from '../services/googleSheetsLedger';
import { SyncWorker, type SyncWorkerOptions } from '../services/syncWorker';

// ---------- tiny harness ----------
const results: { name: string; ok: boolean; err?: unknown }[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- helpers ----------
const row = (n: number, ts = new Date('2026-11-09T10:00:00Z')): LedgerRow => ({
  recordId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  timestamp: ts,
  storeCode: 'NBO-01',
  sku: `SKU-${n}`,
  unitsSold: n,
  totalRevenue: n * 10.5,
});

async function readSheet(buf: Buffer | undefined): Promise<ExcelJS.Worksheet> {
  assert.ok(buf, 'file should exist');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(SHEET_NAME);
  assert.ok(ws, 'Ledger sheet should exist');
  return ws;
}

class MemoryOutbox implements OutboxStore {
  items = new Map<string, OutboxItem & { status: string; next: Date; lockedAt?: Date; error?: string; file?: string }>();
  private seq = 0;
  add(r: LedgerRow): string {
    const id = String(++this.seq);
    this.items.set(id, {
      id, recordId: r.recordId, timestamp: r.timestamp, storeCode: r.storeCode, sku: r.sku,
      unitsSold: r.unitsSold, totalRevenueCents: Math.round(r.totalRevenue * 100), attempts: 0,
      status: 'pending', next: new Date(0),
    });
    return id;
  }
  async reclaimStale(cutoff: Date) {
    let n = 0;
    for (const i of this.items.values())
      if (i.status === 'processing' && i.lockedAt && i.lockedAt < cutoff) { i.status = 'pending'; n++; }
    return n;
  }
  async claimNext(now: Date) {
    const c = [...this.items.values()]
      .filter((i) => i.status === 'pending' && i.next <= now)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
    if (!c) return null;
    c.status = 'processing'; c.lockedAt = now;
    return { ...c };
  }
  async markSynced(ids: string[], file: string) {
    for (const id of ids) { const i = this.items.get(id)!; i.status = 'synced'; i.file = file; }
  }
  async markFailed(id: string, u: FailureUpdate) {
    const i = this.items.get(id)!;
    i.attempts = u.attempts; i.error = u.error; i.status = u.failed ? 'failed' : 'pending'; i.next = u.nextAttemptAt;
  }
  async countOpen() {
    return [...this.items.values()].filter((i) => i.status === 'pending' || i.status === 'processing').length;
  }
}


class MemorySheets implements SheetsApi {
  tabs = new Map<string, { id: number; header: string[]; rows: (string | number)[][]; formatted: boolean }>();
  calls = { createTab: 0, append: 0 };
  private nextId = 1;
  async listTabs() { return [...this.tabs.keys()]; }
  async createTab(title: string) {
    this.calls.createTab++;
    if (this.tabs.has(title)) return null;
    const id = this.nextId++; this.tabs.set(title, { id, header: [], rows: [], formatted: false }); return id;
  }
  async writeHeader(title: string, header: string[]) { this.tabs.get(title)!.header = header; }
  async formatLedgerTab(id: number) { for (const t of this.tabs.values()) if (t.id === id) t.formatted = true; }
  async readRecordIds(title: string) { return (this.tabs.get(title)?.rows ?? []).map((r) => String(r[5])); }
  async appendRows(title: string, rows: (string | number)[][]) { this.calls.append++; this.tabs.get(title)!.rows.push(...rows); }
}

const baseOpts: SyncWorkerOptions = {
  pollMs: 60_000, batchSize: 100, maxAttempts: 3, backoffBaseMs: 100, lockTimeoutMs: 10_000,
  folderPath: 'Ledgers', filePrefix: 'Sales_Ledger', rollover: 'monthly',
};
const PATH = 'Ledgers/Sales_Ledger_2026-11.xlsx';

function rig(opts: Partial<SyncWorkerOptions> = {}) {
  const drive = new MockDriveClient();
  const store = new MemoryOutbox();
  const worker = new SyncWorker(store, new LedgerService(drive), { ...baseOpts, ...opts });
  return { drive, store, worker };
}

async function main(): Promise<void> {
  console.log('\nSchema validation');
  await test('uppercases storeCode, trims sku, accepts valid input', () => {
    const r = saleInputSchema.parse({ storeCode: ' nbo-01 ', sku: '  ab-12  ', unitsSold: 3, totalRevenue: 12.5 });
    assert.equal(r.storeCode, 'NBO-01'); assert.equal(r.sku, 'ab-12');
  });
  await test('rejects non-integer / zero / negative units', () => {
    for (const u of [0, -1, 1.5, Number.NaN]) {
      assert.equal(saleInputSchema.safeParse({ storeCode: 'A1', sku: 'x', unitsSold: u, totalRevenue: 1 }).success, false, `units=${u}`);
    }
  });
  await test('rejects revenue with >2 decimals or negative', () => {
    for (const v of [1.234, -1, Number.NaN, Infinity]) {
      assert.equal(saleInputSchema.safeParse({ storeCode: 'A1', sku: 'x', unitsSold: 1, totalRevenue: v }).success, false, `rev=${v}`);
    }
    assert.equal(saleInputSchema.safeParse({ storeCode: 'A1', sku: 'x', unitsSold: 1, totalRevenue: 0.1 + 0.2 }).success, true);
  });
  await test('rejects Excel formula-injection SKUs', () => {
    for (const sku of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\t=x']) {
      assert.equal(saleInputSchema.safeParse({ storeCode: 'A1', sku, unitsSold: 1, totalRevenue: 1 }).success, false, sku);
    }
  });

  console.log('\nLedgerService (Excel in memory)');
  await test('auto-initialises a styled workbook when the file is missing (404)', async () => {
    const drive = new MockDriveClient();
    const res = await new LedgerService(drive).append(PATH, [row(1)]);
    assert.equal(res.created, true); assert.equal(res.added, 1);
    const ws = await readSheet(drive.getFile(PATH));
    assert.equal(ws.getRow(1).getCell(1).value, 'Timestamp (UTC)');
    assert.equal(ws.getRow(1).getCell(5).value, 'Total Revenue (KES)');
    assert.equal(ws.getRow(1).getCell(1).font?.bold, true);
    assert.equal(ws.views[0]?.state, 'frozen');
    assert.equal(ws.getColumn(6).hidden, true);
    assert.equal(ws.rowCount, 2);
    assert.equal(ws.getRow(2).getCell(5).value, 10.5);
    assert.equal(ws.getRow(2).getCell(5).numFmt, '#,##0.00');
  });
  await test('appends to an existing ledger without losing rows or styling', async () => {
    const drive = new MockDriveClient();
    const svc = new LedgerService(drive);
    await svc.append(PATH, [row(1)]);
    const res = await svc.append(PATH, [row(2), row(3)]);
    assert.equal(res.created, false); assert.equal(res.added, 2);
    const ws = await readSheet(drive.getFile(PATH));
    assert.equal(ws.rowCount, 4);
    assert.equal(ws.getRow(1).getCell(1).font?.bold, true);
    assert.equal(ws.getColumn(6).hidden, true);
  });
  await test('is idempotent: re-sending the same Record IDs adds nothing', async () => {
    const drive = new MockDriveClient();
    const svc = new LedgerService(drive);
    await svc.append(PATH, [row(1), row(2)]);
    const uploadsBefore = drive.calls.upload;
    const res = await svc.append(PATH, [row(1), row(2), row(3)]);
    assert.equal(res.added, 1); assert.equal(res.skippedDuplicates, 2);
    assert.equal((await readSheet(drive.getFile(PATH))).rowCount, 4);
    const res2 = await svc.append(PATH, [row(1)]);
    assert.equal(res2.added, 0); assert.equal(drive.calls.upload, uploadsBefore + 1, 'no upload when nothing new');
  });
  await test('stores SKU as text, never as a formula', async () => {
    const drive = new MockDriveClient();
    await new LedgerService(drive).append(PATH, [{ ...row(1), sku: '=cmd|calc' }]); // defence in depth
    const cell = (await readSheet(drive.getFile(PATH))).getRow(2).getCell(3);
    assert.equal(typeof cell.value, 'string'); assert.equal(cell.value, '=cmd|calc'); assert.equal(cell.type, ExcelJS.ValueType.String);
  });
  await test('5 concurrent writers: no lost updates (eTag conflict + re-read)', async () => {
    const drive = new MockDriveClient(); drive.latencyMs = 15;
    const svc = new LedgerService(drive, 8);
    await svc.append(PATH, [row(100)]);
    await Promise.all([1, 2, 3, 4, 5].map((n) => svc.append(PATH, [row(n)])));
    const ws = await readSheet(drive.getFile(PATH));
    assert.equal(ws.rowCount, 7, 'header + seed + 5 rows');
    const ids = new Set<string>(); ws.getColumn(6).eachCell((c, r) => { if (r > 1) ids.add(String(c.value)); });
    assert.equal(ids.size, 6);
  });
  await test('403 on download is NOT treated as "missing": nothing is overwritten', async () => {
    const drive = new MockDriveClient();
    await new LedgerService(drive).append(PATH, [row(1)]);
    const before = drive.getFile(PATH)!;
    drive.injectFailures(new GraphError('forbidden', 'permanent', 403));
    const uploads = drive.calls.upload;
    await assert.rejects(new LedgerService(drive).append(PATH, [row(2)]), /forbidden/);
    assert.equal(drive.calls.upload, uploads); assert.ok(before.equals(drive.getFile(PATH)!));
  });
  await test('corrupt existing file is refused, not overwritten', async () => {
    const drive = new MockDriveClient();
    drive.putRaw(PATH, Buffer.from('this is not an xlsx'));
    await assert.rejects(new LedgerService(drive).append(PATH, [row(1)]), /refusing to overwrite/);
    assert.equal(drive.getFile(PATH)!.toString(), 'this is not an xlsx');
  });
  await test('create race: second creator gets conflict, then appends to the winner\'s file', async () => {
    const drive = new MockDriveClient(); drive.latencyMs = 10;
    const svc = new LedgerService(drive, 6);
    await Promise.all([svc.append(PATH, [row(1)]), svc.append(PATH, [row(2)])]);
    assert.equal((await readSheet(drive.getFile(PATH))).rowCount, 3);
  });

  console.log('\nGraph error mapping');
  await test('maps HTTP statuses to the right retry behaviour', () => {
    const mk = (status: number, headers: Record<string, string> = {}) =>
      mapError(Object.assign(new Error('x'), {
        isAxiosError: true,
        config: { method: 'put' },
        response: { status, headers, data: { error: { code: 'c' } } },
      }));
    assert.equal(mk(404).kind, 'not_found');
    assert.equal(mk(412).kind, 'conflict');
    assert.equal(mk(423).retryable, true, 'locked file is retried, not failed');
    assert.equal(mk(500).retryable, true);
    const t = mk(429, { 'retry-after': '7' });
    assert.equal(t.kind, 'throttled'); assert.equal(t.retryAfterMs, 7000);
    assert.equal(mk(403).retryable, false);
    assert.equal(mk(401).retryable, false);
  });

  console.log('\nFree OneDrive mode');
  const KEY = 'a'.repeat(64);
  await test('token cache encryption round-trips and rejects tampering / wrong key', () => {
    const blob = encrypt('{"RefreshToken":{"x":"secret"}}', KEY);
    assert.ok(!blob.includes('secret'));
    assert.equal(decrypt(blob, KEY), '{"RefreshToken":{"x":"secret"}}');
    assert.throws(() => decrypt(blob, 'b'.repeat(64)));
    const parts = blob.split('.'); parts[2] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => decrypt(parts.join('.'), KEY));
  });
  await test('not signed in: retryable GraphError telling the user how to sign in', async () => {
    const provider = new DelegatedTokenProvider('00000000-0000-0000-0000-000000000000', { load: async () => null, save: async () => {} });
    await assert.rejects(provider.getToken(), (err: unknown) => {
      assert.ok(err instanceof GraphError); assert.equal(err.retryable, true);
      assert.equal(err.message, NOT_SIGNED_IN); assert.match(err.message, /auth:onedrive/);
      return true;
    });
  });
  await test('env: onedrive mode requires client id + 64-hex encryption key', () => {
    assert.throws(() => loadEnv({ GRAPH_MODE: 'onedrive' } as NodeJS.ProcessEnv), /AZURE_CLIENT_ID/);
    assert.throws(() => loadEnv({ GRAPH_MODE: 'onedrive', AZURE_CLIENT_ID: 'x', TOKEN_ENCRYPTION_KEY: 'short' } as NodeJS.ProcessEnv), /64 hex/);
    const ok = loadEnv({ GRAPH_MODE: 'onedrive', AZURE_CLIENT_ID: 'x', TOKEN_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv);
    assert.equal(ok.GRAPH_MODE, 'onedrive');
  });
  await test('sign-in problems keep records queued with a clear reason', async () => {
    const { drive, store, worker } = rig({ maxAttempts: 2, backoffBaseMs: 100 });
    const id = store.add(row(1));
    drive.injectFailures(new GraphError(NOT_SIGNED_IN, 'transient'));
    await worker.kick();
    assert.equal(store.items.get(id)!.status, 'pending');
    assert.match(store.items.get(id)!.error ?? '', /auth:onedrive/);
  });

  console.log('\nGoogle Sheets mode');
  const SHEET_PATH = 'Ledgers/Sales_Ledger_2026-11.xlsx';
  await test('tab name derives from the ledger path; dates become spreadsheet serials', () => {
    assert.equal(tabNameFor(SHEET_PATH), 'Sales_Ledger_2026-11');
    assert.equal(tabNameFor('Sales_Ledger.xlsx'), 'Sales_Ledger');
    assert.equal(toSerialDate(new Date('1970-01-01T00:00:00Z')), 25569);
    assert.equal(toSerialDate(new Date('2026-11-09T12:00:00Z')), 46335.5);
  });
  await test('creates + formats a tab with KES header once, then appends rows', async () => {
    const api = new MemorySheets(); const ledger = new GoogleSheetsLedger(api, 'KES');
    const r1 = await ledger.append(SHEET_PATH, [row(1), row(2)]);
    assert.deepEqual([r1.created, r1.added], [true, 2]);
    const tab = api.tabs.get('Sales_Ledger_2026-11')!;
    assert.equal(tab.header[4], 'Total Revenue (KES)'); assert.equal(tab.formatted, true);
    const r2 = await ledger.append(SHEET_PATH, [row(3)]);
    assert.deepEqual([r2.created, r2.added], [false, 1]);
    assert.equal(tab.rows.length, 3); assert.equal(api.calls.createTab, 1);
    assert.equal(tab.rows[0]![4], 10.5);
  });
  await test('sheets: re-sending the same Record IDs adds nothing (no append call)', async () => {
    const api = new MemorySheets(); const ledger = new GoogleSheetsLedger(api);
    await ledger.append(SHEET_PATH, [row(1), row(2)]);
    const before = api.calls.append;
    const res = await ledger.append(SHEET_PATH, [row(1), row(2), row(3)]);
    assert.deepEqual([res.added, res.skippedDuplicates], [1, 2]);
    const none = await ledger.append(SHEET_PATH, [row(1)]);
    assert.equal(none.added, 0); assert.equal(api.calls.append, before + 1);
  });
  await test('sheets: a tab created by another writer is reused (create race), no second header', async () => {
    const api = new MemorySheets(); const ledger = new GoogleSheetsLedger(api);
    await Promise.all([ledger.append(SHEET_PATH, [row(1)]), ledger.append(SHEET_PATH, [row(2)])]);
    assert.equal(api.tabs.size, 1); assert.equal(api.tabs.get('Sales_Ledger_2026-11')!.rows.length, 2);
  });
  await test('sheets: SKU is passed through as plain text for RAW insertion', async () => {
    const api = new MemorySheets();
    await new GoogleSheetsLedger(api).append(SHEET_PATH, [{ ...row(1), sku: '=cmd|calc' }]);
    assert.equal(api.tabs.get('Sales_Ledger_2026-11')!.rows[0]![2], '=cmd|calc');
  });
  await test('sheets: worker syncs records into Google Sheets end to end', async () => {
    const api = new MemorySheets(); const store = new MemoryOutbox();
    const worker = new SyncWorker(store, new GoogleSheetsLedger(api), baseOpts);
    [1, 2, 3].forEach((n) => store.add(row(n)));
    await worker.drain();
    assert.ok([...store.items.values()].every((i) => i.status === 'synced'));
    assert.equal(api.tabs.get('Sales_Ledger_2026-11')!.rows.length, 3); assert.equal(api.calls.append, 1);
  });
  await test('sheets: HTTP errors map to the right retry behaviour and helpful messages', () => {
    const mk = (status: number, message = 'm', headers: Record<string, string> = {}) =>
      mapSheetsError(Object.assign(new Error('x'), { isAxiosError: true, response: { status, headers, data: { error: { message } } } }));
    assert.equal(mk(429, 'quota', { 'retry-after': '3' }).retryAfterMs, 3000);
    assert.equal(mk(503).retryable, true);
    const nf = mk(404); assert.equal(nf.retryable, false); assert.match(nf.message, /share the sheet/i);
    const fb = mk(403, 'API disabled'); assert.equal(fb.retryable, false); assert.match(fb.message, /Editor/);
    assert.equal(mapSheetsError(Object.assign(new Error('x'), { isAxiosError: true, response: undefined })).retryable, true);
  });
  await test('service-account JSON parsing and env validation for sheets mode', () => {
    const good = Buffer.from(JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' })).toString('base64');
    assert.equal(parseServiceAccountJson(good).client_email, 'a@b.iam.gserviceaccount.com');
    assert.throws(() => parseServiceAccountJson('%%%'), /valid base64/);
    assert.throws(() => parseServiceAccountJson(Buffer.from('{}').toString('base64')), /client_email/);
    assert.throws(() => loadEnv({ GRAPH_MODE: 'sheets' } as NodeJS.ProcessEnv), /GOOGLE_SHEET_ID/);
    assert.equal(loadEnv({ GRAPH_MODE: 'sheets', GOOGLE_SHEET_ID: 'x', GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: good } as NodeJS.ProcessEnv).GRAPH_MODE, 'sheets');
  });

  console.log('\nSyncWorker (outbox)');
  await test('drains a batch with ONE download+upload and marks records synced', async () => {
    const { drive, store, worker } = rig();
    [1, 2, 3].forEach((n) => store.add(row(n)));
    await worker.drain();
    assert.ok([...store.items.values()].every((i) => i.status === 'synced'));
    assert.equal(drive.calls.upload, 1);
    assert.equal((await readSheet(drive.getFile(PATH))).rowCount, 4);
  });
  await test('monthly rollover routes records to separate files', async () => {
    const { drive, store, worker } = rig();
    store.add(row(1, new Date('2026-10-31T23:59:00Z'))); store.add(row(2, new Date('2026-11-01T00:01:00Z')));
    await worker.drain();
    assert.deepEqual(drive.listFiles().sort(), ['Ledgers/Sales_Ledger_2026-10.xlsx', 'Ledgers/Sales_Ledger_2026-11.xlsx']);
  });
  await test('throttling (429 + Retry-After) keeps the record safe and retries to success', async () => {
    const { drive, store, worker } = rig({ backoffBaseMs: 100 });
    const id = store.add(row(1));
    drive.injectFailures(new GraphError('throttled', 'throttled', 429, 200));
    await worker.kick();
    const after1 = store.items.get(id)!;
    assert.equal(after1.status, 'pending'); assert.equal(after1.attempts, 1); assert.match(after1.error ?? '', /throttled/);
    assert.ok(after1.next.getTime() - Date.now() >= 100, 'honours backoff / Retry-After');
    await worker.drain();
    assert.equal(store.items.get(id)!.status, 'synced');
  });
  await test('permanent error (403) fails immediately with a recorded reason', async () => {
    const { drive, store, worker } = rig();
    const id = store.add(row(1));
    drive.injectFailures(new GraphError('Graph GET failed (403): accessDenied', 'permanent', 403));
    await worker.kick();
    const i = store.items.get(id)!;
    assert.equal(i.status, 'failed'); assert.equal(i.attempts, 1); assert.match(i.error ?? '', /403/);
  });
  await test('transient errors exhaust maxAttempts, then record is marked failed', async () => {
    const { drive, store, worker } = rig({ maxAttempts: 3, backoffBaseMs: 100 });
    const id = store.add(row(1));
    for (let i = 0; i < 3; i++) drive.injectFailures(new GraphError('boom', 'transient', 503));
    for (let i = 0; i < 3; i++) { store.items.get(id)!.next = new Date(0); await worker.kick(); }
    const it = store.items.get(id)!;
    assert.equal(it.status, 'failed'); assert.equal(it.attempts, 3);
  });
  await test('stale "processing" locks are reclaimed after a crash', async () => {
    const { store, worker } = rig({ lockTimeoutMs: 10_000 });
    const id = store.add(row(1));
    const it = store.items.get(id)!; it.status = 'processing'; it.lockedAt = new Date(Date.now() - 60_000);
    await worker.drain();
    assert.equal(store.items.get(id)!.status, 'synced');
  });
  await test('SharePoint outage: records outlive the outage and syncs after recovery', async () => {
    const { drive, store, worker } = rig({ maxAttempts: 6, backoffBaseMs: 100 });
    [1, 2].forEach((n) => store.add(row(n)));
    drive.injectFailures(new GraphError('timeout', 'transient'), new GraphError('timeout', 'transient'));
    await worker.kick();
    assert.ok([...store.items.values()].every((i) => i.status === 'pending' && i.attempts === 1));
    for (const i of store.items.values()) i.next = new Date(0);
    await worker.drain();
    assert.ok([...store.items.values()].every((i) => i.status === 'synced'));
    assert.equal((await readSheet(drive.getFile(PATH))).rowCount, 3);
  });

  console.log('\nHTTP layer (no database required)');
  const env = loadEnv({ NODE_ENV: 'test', GRAPH_MODE: 'mock' } as NodeJS.ProcessEnv);
  const { worker } = rig();
  const server = createApp({ env, worker }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await test('POST /api/sales returns 422 with field-level issues for bad input', async () => {
    const res = await fetch(`${base}/api/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storeCode: 'N', sku: '=1+1', unitsSold: 1.5, totalRevenue: 1.234 }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { issues: { field: string }[] };
    assert.deepEqual(body.issues.map((i) => i.field).sort(), ['sku', 'storeCode', 'totalRevenue', 'unitsSold']);
  });
  await test('malformed JSON returns 400; unknown route 404; retry endpoint requires admin key', async () => {
    const bad = await fetch(`${base}/api/sales`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/sales/x/retry`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/sales/retry-failed`, { method: 'POST' })).status, 401);
  });
  await test('security headers present, x-powered-by hidden', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('x-content-type-options'));
  });
  await test('env validation: live mode demands Azure settings; mock banned in production', () => {
    assert.throws(() => loadEnv({ GRAPH_MODE: 'live' } as NodeJS.ProcessEnv), /AZURE_TENANT_ID/);
    assert.throws(() => loadEnv({ NODE_ENV: 'production', GRAPH_MODE: 'mock' } as NodeJS.ProcessEnv), /not allowed in production/);
  });
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
