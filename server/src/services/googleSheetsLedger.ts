import axios from 'axios';
import { JWT } from 'google-auth-library';
import { GraphError, type TokenProvider } from './graph/types';
import type { AppendResult, LedgerRow, LedgerSink } from './ledgerWorkbook';
import { logger } from '../utils/logger';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const NAVY = { red: 0.122, green: 0.22, blue: 0.392 };
const ZEBRA = { red: 0.949, green: 0.961, blue: 0.98 };
const RECORD_ID_COL_INDEX = 5; // column F

/** Low-level operations on ONE spreadsheet. Real implementation: REST; tests: in-memory. */
export interface SheetsApi {
  listTabs(): Promise<string[]>;
  /** Returns the new tab's sheetId, or null if a tab with that title already exists (create race). */
  createTab(title: string): Promise<number | null>;
  writeHeader(title: string, header: string[]): Promise<void>;
  formatLedgerTab(sheetId: number): Promise<void>;
  /** Values of column F (Record ID), from row 2 down. */
  readRecordIds(title: string): Promise<string[]>;
  appendRows(title: string, rows: (string | number)[][]): Promise<void>;
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Decodes the base64 of the downloaded service-account JSON key file. */
export function parseServiceAccountJson(base64: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON');
  }
  const o = parsed as Partial<ServiceAccount> | null;
  if (!o || typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new Error('Service-account JSON must contain "client_email" and "private_key"');
  }
  return { client_email: o.client_email, private_key: o.private_key };
}

export class GoogleTokenProvider implements TokenProvider {
  private readonly jwt: JWT;
  constructor(sa: ServiceAccount) {
    this.jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  }
  async getToken(): Promise<string> {
    try {
      const { token } = await this.jwt.getAccessToken();
      if (!token) throw new Error('no token returned');
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // invalid_grant / invalid_client = bad key (permanent); anything else is probably network.
      const permanent = /invalid_grant|invalid_client|unauthorized_client|invalid_scope/i.test(msg);
      throw new GraphError(`Google auth failed: ${msg}`, permanent ? 'permanent' : 'transient');
    }
  }
}

export function mapSheetsError(err: unknown): GraphError {
  if (err instanceof GraphError) return err;
  if (!axios.isAxiosError(err)) return new GraphError(err instanceof Error ? err.message : String(err), 'permanent');
  const status = err.response?.status;
  const body = err.response?.data as { error?: { message?: string } } | undefined;
  const detail = body?.error?.message ?? err.code ?? 'unknown';
  if (!status) return new GraphError(`Sheets request failed (no response): ${detail}`, 'transient');
  if (status === 429) {
    const raw = err.response?.headers?.['retry-after'];
    const secs = typeof raw === 'string' ? Number(raw) : NaN;
    return new GraphError(`Sheets rate limited: ${detail}`, 'throttled', status, Number.isFinite(secs) ? secs * 1000 : undefined);
  }
  if (status === 408 || status >= 500) return new GraphError(`Sheets server error ${status}: ${detail}`, 'transient', status);
  if (status === 404) {
    return new GraphError('Spreadsheet not found. Check GOOGLE_SHEET_ID and share the sheet with the service-account email as Editor.', 'permanent', status);
  }
  if (status === 403) {
    return new GraphError(`Permission denied (${detail}). Share the sheet with the service-account email as Editor, and enable the Google Sheets API in the project.`, 'permanent', status);
  }
  return new GraphError(`Sheets request rejected (${status}): ${detail}`, 'permanent', status);
}

export class SheetsRestApi implements SheetsApi {
  private readonly http = axios.create({ timeout: 30_000 });
  private readonly base: string;

  constructor(
    spreadsheetId: string,
    private readonly tokens: TokenProvider,
  ) {
    this.base = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}`;
  }

  private async call<T>(method: 'get' | 'post' | 'put', path: string, data?: unknown, params?: Record<string, string>): Promise<T> {
    const headers = { Authorization: `Bearer ${await this.tokens.getToken()}` };
    try {
      const res = await this.http.request<T>({ method, url: `${this.base}${path}`, data, params, headers });
      return res.data;
    } catch (err) {
      throw mapSheetsError(err);
    }
  }

  private range(title: string, a1: string): string {
    return encodeURIComponent(`'${title.replace(/'/g, "''")}'!${a1}`);
  }

  async listTabs(): Promise<string[]> {
    const res = await this.call<{ sheets?: { properties: { title: string } }[] }>('get', '', undefined, {
      fields: 'sheets.properties.title',
    });
    return (res.sheets ?? []).map((s) => s.properties.title);
  }

  async createTab(title: string): Promise<number | null> {
    try {
      const res = await this.call<{ replies: { addSheet: { properties: { sheetId: number } } }[] }>('post', ':batchUpdate', {
        requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1, columnCount: 6 } } } }],
      });
      return res.replies[0]?.addSheet.properties.sheetId ?? null;
    } catch (err) {
      if (err instanceof GraphError && /already exists/i.test(err.message)) return null;
      throw err;
    }
  }

  async writeHeader(title: string, header: string[]): Promise<void> {
    await this.call('put', `/values/${this.range(title, 'A1:F1')}`, { values: [header] }, { valueInputOption: 'RAW' });
  }

  async formatLedgerTab(sheetId: number): Promise<void> {
    const col = (start: number, end: number, rowStart = 1) => ({ sheetId, startRowIndex: rowStart, startColumnIndex: start, endColumnIndex: end });
    const fmt = (start: number, end: number, type: string, pattern: string) => ({
      repeatCell: {
        range: col(start, end),
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
    await this.call('post', ':batchUpdate', {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                backgroundColor: NAVY,
                horizontalAlignment: 'CENTER',
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
          },
        },
        fmt(0, 1, 'DATE_TIME', 'yyyy-mm-dd hh:mm:ss'),
        fmt(3, 4, 'NUMBER', '#,##0'),
        fmt(4, 5, 'NUMBER', '#,##0.00'),
        { addBanding: { bandedRange: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 5 }, rowProperties: { headerColor: NAVY, firstBandColor: { red: 1, green: 1, blue: 1 }, secondBandColor: ZEBRA } } } },
        { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 5 } } } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 170 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 5 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: RECORD_ID_COL_INDEX, endIndex: RECORD_ID_COL_INDEX + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
      ],
    });
  }

  async readRecordIds(title: string): Promise<string[]> {
    const res = await this.call<{ values?: string[][] }>('get', `/values/${this.range(title, 'F2:F')}`);
    return (res.values ?? []).map((r) => r[0] ?? '').filter(Boolean);
  }

  async appendRows(title: string, rows: (string | number)[][]): Promise<void> {
    // RAW: values are stored exactly as sent, so a SKU like "=1+1" can never become a formula.
    await this.call('post', `/values/${this.range(title, 'A:F')}:append`, { values: rows }, {
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
    });
  }
}

/** Spreadsheet serial date: days since 1899-12-30 (what Sheets/Excel use for date-times). */
export const toSerialDate = (d: Date): number => d.getTime() / 86_400_000 + 25_569;

/** Tab name = file name without extension, e.g. "Ledgers/Sales_Ledger_2026-11.xlsx" -> "Sales_Ledger_2026-11". */
export const tabNameFor = (path: string): string =>
  (path.split('/').pop() ?? path).replace(/\.xlsx$/i, '').slice(0, 99) || 'Ledger';

export class GoogleSheetsLedger implements LedgerSink {
  constructor(
    private readonly api: SheetsApi,
    private readonly currency = 'KES',
  ) {}

  async append(path: string, rows: LedgerRow[]): Promise<AppendResult> {
    const tab = tabNameFor(path);
    let created = false;

    if (!(await this.api.listTabs()).includes(tab)) {
      const sheetId = await this.api.createTab(tab); // null = another writer just created it
      if (sheetId !== null) {
        await this.api.writeHeader(tab, ['Timestamp (UTC)', 'Store Code', 'SKU', 'Units Sold', `Total Revenue (${this.currency})`, 'Record ID']);
        await this.api.formatLedgerTab(sheetId);
        created = true;
        logger.info('sheets.tab_created', { tab });
      }
    }

    const existing = new Set(await this.api.readRecordIds(tab));
    const fresh = rows.filter((r) => !existing.has(r.recordId));
    if (fresh.length > 0) {
      await this.api.appendRows(
        tab,
        fresh.map((r) => [toSerialDate(r.timestamp), r.storeCode, r.sku, r.unitsSold, r.totalRevenue, r.recordId]),
      );
    }
    return { created, added: fresh.length, skippedDuplicates: rows.length - fresh.length };
  }
}
