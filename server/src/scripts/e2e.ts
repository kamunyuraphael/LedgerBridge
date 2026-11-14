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
import { readTable } from '../services/importers';
import { presentOrder } from '../services/orderService';
import {
  canTransition, normalizePo, uniqueSupplierCodes,
} from '../services/orderLogic';
import { submitOrderSchema } from '../schemas/order';
import { GoogleSheetsOrderLedger, ORDER_HEADER, orderTabFor, type OrderLedgerRow } from '../services/orderLedger';
import { OrderLedgerWorker, type LedgerFailure, type LedgerJob, type OrderLedgerStore } from '../services/orderLedgerWorker';
import {
  GoogleSheetsLedger, buildAppendCells, mapSheetsError, parseServiceAccountJson, tabNameFor, toSerialDate, type SheetRow, type SheetsApi,
} from '../services/googleSheetsLedger';
import { SyncWorker, type SyncWorkerOptions } from '../services/syncWorker';

type OrderLedgerSinkLike = import('../services/orderLedger').OrderLedgerSink;
type NumFmt = { numberFormat?: { type?: string; pattern?: string } };
const JWT = 'j'.repeat(48);

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
  async listTabs() { return new Map([...this.tabs].map(([title, t]) => [title, t.id] as [string, number])); }
  async createTab(title: string) {
    this.calls.createTab++;
    if (this.tabs.has(title)) return null;
    const id = this.nextId++; this.tabs.set(title, { id, header: [], rows: [], formatted: false }); return id;
  }
  async writeHeader(title: string, header: string[]) { this.tabs.get(title)!.header = header; }
  async formatLedgerTab(id: number) { for (const t of this.tabs.values()) if (t.id === id) t.formatted = true; }
  async readRecordIds(title: string) { return (this.tabs.get(title)?.rows ?? []).map((r) => String(r[5])); }
  async readColumn(title: string, col: number) { return (this.tabs.get(title)?.rows ?? []).map((r) => String(r[col] ?? '')); }
  async updateCells(title: string, updates: { row: number; col: number; value: string | number }[]) {
    const t = this.tabs.get(title)!;
    for (const u of updates) t.rows[u.row - 2]![u.col] = u.value;
  }
  async appendRows(sheetId: number, rows: SheetRow[]) {
    this.calls.append++;
    for (const t of this.tabs.values()) if (t.id === sheetId) t.rows.push(...rows);
  }
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
    assert.throws(() => loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'onedrive' } as NodeJS.ProcessEnv), /AZURE_CLIENT_ID/);
    assert.throws(() => loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'onedrive', AZURE_CLIENT_ID: 'x', TOKEN_ENCRYPTION_KEY: 'short' } as NodeJS.ProcessEnv), /64 hex/);
    const ok = loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'onedrive', AZURE_CLIENT_ID: 'x', TOKEN_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv);
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
  await test('sheets: appended cells carry explicit dark, non-bold formatting (no header inheritance)', () => {
    const req = buildAppendCells(7, [[46336.5, 'NYC1', '=cmd|calc', 3, 1250.5, 'rid']]).appendCells;
    assert.equal(req.sheetId, 7);
    const cells = req.rows[0]!.values;
    assert.equal(cells.length, 6);
    for (const c of cells) {
      assert.equal(c.userEnteredFormat.textFormat.bold, false);
      const fg = c.userEnteredFormat.textFormat.foregroundColor;
      assert.ok(fg.red < 0.3 && fg.green < 0.3 && fg.blue < 0.3, 'text must be dark, never white');
    }
    assert.deepEqual(cells[0]!.userEnteredValue, { numberValue: 46336.5 });
    assert.equal((cells[0]!.userEnteredFormat as NumFmt).numberFormat?.type, 'DATE_TIME');
    assert.equal((cells[4]!.userEnteredFormat as NumFmt).numberFormat?.pattern, '#,##0.00');
    assert.deepEqual(cells[2]!.userEnteredValue, { stringValue: '=cmd|calc' }); // literal text, never a formula
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
    assert.throws(() => loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'sheets' } as NodeJS.ProcessEnv), /GOOGLE_SHEET_ID/);
    assert.equal(loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'sheets', GOOGLE_SHEET_ID: 'x', GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: good } as NodeJS.ProcessEnv).GRAPH_MODE, 'sheets');
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

  console.log('\nOrder ledger (approved orders -> sheet)');
  const baseOrder = (over: Partial<OrderLedgerRow> = {}): OrderLedgerRow => ({
    orderNo: 'ORD-20261113-0001', approvedAt: new Date('2026-11-13T09:30:00Z'), branchName: 'Thindigua', supplierName: 'Brookside Dairy Ltd.',
    status: 'approved', ...over,
  });
  await test('tab name follows approval month in Nairobi time', () => {
    assert.equal(orderTabFor('Orders', new Date('2026-11-13T09:30:00Z')), 'Orders_2026-11');
    assert.equal(orderTabFor('Orders', new Date('2026-11-30T21:30:00Z')), 'Orders_2026-12'); // 00:30 on 1 Dec in Nairobi
  });
  await test('first sync creates the tab with the order header and appends one row for the order', async () => {
    const api = new MemorySheets(); const sink = new GoogleSheetsOrderLedger(api);
    const r = await sink.sync('Orders_2026-11', baseOrder({ supplierName: '=Brookside' }));
    assert.deepEqual(r, { created: true, added: 1, updated: 0 });
    const t = api.tabs.get('Orders_2026-11')!;
    assert.deepEqual(t.header, ORDER_HEADER);
    assert.ok(t.formatted);
    assert.equal(t.rows.length, 1);
    assert.deepEqual(t.rows[0]!.slice(1, 3), ['ORD-20261113-0001', '']);
    assert.equal(t.rows[0]![6], 'ORD-20261113-0001'); // hidden Record ID
    assert.equal(t.rows[0]![4], '=Brookside'); // kept as literal text
    // 09:30 UTC is 12:30 in Nairobi
    assert.ok(Math.abs((t.rows[0]![0] as number) % 1 - 12.5 / 24) < 1e-6);
  });
  await test('re-sync never duplicates the row; PO number and status are refreshed in place', async () => {
    const api = new MemorySheets(); const sink = new GoogleSheetsOrderLedger(api);
    await sink.sync('T', baseOrder());
    const r = await sink.sync('T', baseOrder({ poNumber: 'PO12345', status: 'sent' }));
    assert.deepEqual(r, { created: false, added: 0, updated: 1 });
    const rows = api.tabs.get('T')!.rows;
    assert.equal(rows.length, 1);
    assert.ok(rows.every((x) => x[2] === 'PO12345' && x[5] === 'Sent to supplier'));
    await sink.sync('T', baseOrder({ poNumber: 'PO12345', status: 'cancelled' }));
    assert.ok(rows.every((x) => x[5] === 'Cancelled'));
  });
  await test('two orders in one tab stay separate', async () => {
    const api = new MemorySheets(); const sink = new GoogleSheetsOrderLedger(api);
    await sink.sync('T', baseOrder());
    await sink.sync('T', baseOrder({ orderNo: 'ORD-20261113-0002', branchName: 'Ruaka' }));
    await sink.sync('T', baseOrder({ poNumber: 'PO9' }));
    const rows = api.tabs.get('T')!.rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r[2]), ['PO9', '']);
  });

  class MemoryOrderStore implements OrderLedgerStore {
    jobs = new Map<string, LedgerJob & { state: 'pending' | 'processing' | 'synced' | 'failed'; next: Date; rev: number }>();
    add(id: string, over: Partial<OrderLedgerRow> = {}) { this.jobs.set(id, { id, rev: 0, attempts: 0, ...baseOrder({ orderNo: `ORD-${id}`, ...over }), state: 'pending', next: new Date(0) }); }
    requeue(id: string, over: Partial<OrderLedgerRow>) { const j = this.jobs.get(id)!; Object.assign(j, over, { state: 'pending', rev: j.rev + 1, attempts: 0, next: new Date(0) }); }
    async reclaimStale() { return 0; }
    async claimNext(now: Date) {
      for (const j of this.jobs.values()) if (j.state === 'pending' && j.next <= now) { j.state = 'processing'; return { ...j }; }
      return null;
    }
    async markSynced(job: LedgerJob) { const j = this.jobs.get(job.id)!; if (j.rev === job.rev) j.state = 'synced'; }
    async markFailed(job: LedgerJob, f: LedgerFailure) { const j = this.jobs.get(job.id)!; if (j.rev !== job.rev) return; j.attempts = f.attempts; j.state = f.failed ? 'failed' : 'pending'; j.next = f.nextAt; }
    async countOpen() { return [...this.jobs.values()].filter((j) => j.state === 'pending' || j.state === 'processing').length; }
  }
  const opts = { pollMs: 50, maxAttempts: 3, backoffBaseMs: 100, lockTimeoutMs: 60_000, tabPrefix: 'Orders' };
  await test('worker pushes approved orders, then picks up a later PO number without duplicating rows', async () => {
    const api = new MemorySheets(); const store = new MemoryOrderStore();
    const w = new OrderLedgerWorker(store, new GoogleSheetsOrderLedger(api), opts);
    store.add('1'); store.add('2', { branchName: 'Ruaka' });
    await w.drain();
    assert.equal(api.tabs.get('Orders_2026-11')!.rows.length, 2);
    store.requeue('1', { poNumber: 'PO77', status: 'sent' });
    await w.drain();
    const rows = api.tabs.get('Orders_2026-11')!.rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r[2] === 'PO77').length, 1);
  });
  await test('worker retries transient Sheets errors with backoff and succeeds after recovery', async () => {
    const api = new MemorySheets(); const store = new MemoryOrderStore();
    let down = true;
    const flaky: OrderLedgerSinkLike = { sync: async (t, o) => { if (down) throw new GraphError('boom', 'transient'); return new GoogleSheetsOrderLedger(api).sync(t, o); } };
    const w = new OrderLedgerWorker(store, flaky, opts);
    store.add('1');
    await w.kick();
    assert.equal(store.jobs.get('1')!.state, 'pending');
    assert.equal(store.jobs.get('1')!.attempts, 1);
    down = false; store.jobs.get('1')!.next = new Date(0);
    await w.drain();
    assert.equal(store.jobs.get('1')!.state, 'synced');
    assert.equal(api.tabs.get('Orders_2026-11')!.rows.length, 1);
  });
  await test('worker gives up on permanent errors and after max attempts; a change during sync keeps it queued', async () => {
    const store = new MemoryOrderStore();
    const dead: OrderLedgerSinkLike = { sync: async () => { throw new GraphError('forbidden', 'permanent', 403); } };
    const w = new OrderLedgerWorker(store, dead, opts);
    store.add('1'); await w.kick();
    assert.equal(store.jobs.get('1')!.state, 'failed');
    const api = new MemorySheets();
    const store2 = new MemoryOrderStore(); store2.add('9');
    let once = true;
    const racing: OrderLedgerSinkLike = { sync: async (t, o) => { const r = await new GoogleSheetsOrderLedger(api).sync(t, o); if (once) { once = false; store2.requeue('9', { poNumber: 'PO1' }); } return r; } };
    const w2 = new OrderLedgerWorker(store2, racing, opts);
    await w2.drain();
    assert.equal(store2.jobs.get('9')!.state, 'synced');
    assert.equal(api.tabs.get('Orders_2026-11')!.rows.every((r) => r[2] === 'PO1'), true); // the PO change made during the sync is not lost
  });

  console.log('\nOrders: pure rules');
  await test('status transitions: HQ follows the lifecycle, branch may only cancel a submitted order', () => {
    assert.ok(canTransition('submitted', 'approved', 'hq'));
    assert.ok(canTransition('approved', 'sent', 'hq'));
    assert.ok(canTransition('sent', 'fulfilled', 'hq'));
    assert.ok(!canTransition('submitted', 'sent', 'hq'));
    assert.ok(!canTransition('rejected', 'approved', 'hq'));
    assert.ok(!canTransition('fulfilled', 'cancelled', 'hq'));
    assert.ok(canTransition('submitted', 'cancelled', 'branch'));
    assert.ok(!canTransition('approved', 'cancelled', 'branch'));
    assert.ok(!canTransition('submitted', 'approved', 'branch'));
  });
  await test('PO numbers are normalised and validated', () => {
    assert.equal(normalizePo(' po 123/26 '), 'PO123/26');
    assert.equal(normalizePo('x'), null);
    assert.equal(normalizePo('bad!chars'), null);
  });
  await test('supplier codes are trimmed, upper-cased and de-duplicated in order', () => {
    assert.deepEqual(uniqueSupplierCodes([' v0002', 'V0002', 'v0017', '']), ['V0002', 'V0017']);
  });
  await test('submit schema: branches send supplier codes only (no products or quantities), bounded size', () => {
    const good = { requestId: crypto.randomUUID(), supplierCodes: ['V0002', 'v0017'] };
    assert.ok(submitOrderSchema.safeParse(good).success);
    assert.ok(!submitOrderSchema.safeParse({ ...good, requestId: 'nope' }).success);
    assert.ok(!submitOrderSchema.safeParse({ ...good, supplierCodes: [] }).success);
    assert.ok(!submitOrderSchema.safeParse({ ...good, supplierCodes: ['=cmd'] }).success);
    assert.ok(!submitOrderSchema.safeParse({ ...good, supplierCodes: Array.from({ length: 61 }, (_, i) => `V${i}`) }).success);
    // products and quantities are HQ's business: anything extra is dropped
    const parsed = submitOrderSchema.parse({ ...good, qty: 99999, itemNos: ['JT1'], lines: [{ itemNo: 'JT1', qty: 5 }] });
    assert.deepEqual(Object.keys(parsed).sort(), ['requestId', 'supplierCodes']);
  });
  await test('an order carries no products or quantities', () => {
    const now = new Date();
    const o = {
      _id: 'x', orderNo: 'O1', branchCode: 'J001', branchName: 'B', supplierCode: 'V1', supplierName: 'S', status: 'submitted',
      history: [], createdAt: now, updatedAt: now,
    } as unknown as Parameters<typeof presentOrder>[0];
    const j = JSON.stringify(presentOrder(o));
    assert.ok(!/qty|lines|itemNo/i.test(j));
  });
  await test('import reader: finds headers in any sheet, cleans non-breaking spaces, skips unusable sheets', async () => {
    const wb = new ExcelJS.Workbook();
    const junk = wb.addWorksheet('Notes');
    junk.addRow(['Hello', 'World']);
    const b = wb.addWorksheet('Vendors');
    b.addRow(['No.', 'Name']);
    b.addRow(['v0002', 'Brookside\u00a0Dairy\u00a0Ltd']);
    b.addRow([]);
    b.addRow(['V0017', 'Jaza  Bakery']);
    const rows = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'suppliers');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.name, 'Brookside Dairy Ltd');
    assert.equal(rows[1]!.name, 'Jaza Bakery');
    assert.equal(rows[0]!.code, 'v0002');
  });

  console.log('\nHTTP layer (no database required)');
  const env = loadEnv({ JWT_SECRET: JWT, NODE_ENV: 'test', GRAPH_MODE: 'mock' } as NodeJS.ProcessEnv);
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
  await test('auth: orders/catalogue/admin need a token; login validates its body; bad token rejected', async () => {
    for (const path of ['/api/orders', '/api/orders/summary', '/api/catalogue/suppliers', '/api/admin/users', '/api/auth/me']) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
    assert.equal((await fetch(`${base}/api/orders`, { headers: { authorization: 'Bearer garbage' } })).status, 401);
    const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 422);
  });
  await test('security headers present, x-powered-by hidden', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('x-content-type-options'));
  });
  await test('env validation: live mode demands Azure settings; mock banned in production', () => {
    assert.throws(() => loadEnv({ JWT_SECRET: JWT, GRAPH_MODE: 'live' } as NodeJS.ProcessEnv), /AZURE_TENANT_ID/);
    assert.throws(() => loadEnv({ GRAPH_MODE: 'mock', JWT_SECRET: 'short' } as NodeJS.ProcessEnv), /JWT_SECRET/);
    assert.throws(() => loadEnv({ JWT_SECRET: JWT, NODE_ENV: 'production', GRAPH_MODE: 'mock' } as NodeJS.ProcessEnv), /not allowed in production/);
  });
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
