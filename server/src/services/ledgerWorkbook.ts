import ExcelJS from 'exceljs';
import { GraphError, type DriveClient } from './graph/types';
import { logger } from '../utils/logger';

export const SHEET_NAME = 'Ledger';
const HEADER_FILL = 'FF1F3864'; // executive navy
const ZEBRA_FILL = 'FFF2F5FA';

export interface LedgerRow {
  recordId: string;
  timestamp: Date;
  storeCode: string;
  sku: string;
  unitsSold: number;
  totalRevenue: number;
}

const columns = (currency: string): Partial<ExcelJS.Column>[] => [
  { header: 'Timestamp (UTC)', key: 'timestamp', width: 22 },
  { header: 'Store Code', key: 'storeCode', width: 14 },
  { header: 'SKU', key: 'sku', width: 22 },
  { header: 'Units Sold', key: 'unitsSold', width: 14 },
  { header: `Total Revenue (${currency})`, key: 'totalRevenue', width: 22 },
  { header: 'Record ID', key: 'recordId', width: 38, hidden: true },
];
const RECORD_ID_COL = 6;

export class LedgerCorruptError extends GraphError {
  constructor(message: string) {
    super(message, 'permanent');
    this.name = 'LedgerCorruptError';
  }
}

/** Builds a fresh, styled workbook (auto-initialisation path). */
function createWorkbook(currency: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LedgerBridge';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns(currency);

  const header = ws.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF8EA9DB' } } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
  return wb;
}

function styleDataRow(row: ExcelJS.Row): void {
  const zebra = row.number % 2 === 0;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    if (col > 5) return;
    cell.border = { bottom: { style: 'hair', color: { argb: 'FFBFBFBF' } } };
    if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } };
  });
  row.getCell(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  row.getCell(2).alignment = { horizontal: 'center' };
  row.getCell(3).numFmt = '@'; // force text: never interpreted as a formula
  row.getCell(4).numFmt = '#,##0';
  row.getCell(5).numFmt = '#,##0.00';
}

/** Appends rows to the sheet, skipping Record IDs already present. Returns rows actually added. */
function appendRows(wb: ExcelJS.Workbook, rows: LedgerRow[]): number {
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new LedgerCorruptError(`Workbook has no "${SHEET_NAME}" sheet; refusing to modify it`);

  const existing = new Set<string>();
  ws.getColumn(RECORD_ID_COL).eachCell((cell, rowNumber) => {
    if (rowNumber > 1 && typeof cell.value === 'string') existing.add(cell.value);
  });

  let added = 0;
  for (const r of rows) {
    if (existing.has(r.recordId)) continue;
    const row = ws.addRow([r.timestamp, r.storeCode, String(r.sku), r.unitsSold, r.totalRevenue, r.recordId]);
    styleDataRow(row);
    existing.add(r.recordId);
    added++;
  }
  return added;
}

export interface AppendResult {
  created: boolean;
  added: number;
  skippedDuplicates: number;
}

/**
 * Downloads the ledger into memory, appends rows, and uploads the result.
 * No file ever touches local disk. Safe against concurrent writers via eTag / create-only checks.
 */
/** Anything the sync worker can append ledger rows to (Excel file in a drive, Google Sheet, ...). */
export interface LedgerSink {
  append(path: string, rows: LedgerRow[]): Promise<AppendResult>;
}

export class LedgerService implements LedgerSink {
  constructor(
    private readonly drive: DriveClient,
    private readonly maxConflictRetries = 4,
    private readonly currency = 'KES',
  ) {}

  async append(path: string, rows: LedgerRow[]): Promise<AppendResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt++) {
      try {
        return await this.appendOnce(path, rows);
      } catch (err) {
        // 409 / 412: someone else wrote first. Re-read and re-apply (rows are idempotent by Record ID).
        if (err instanceof GraphError && err.kind === 'conflict') {
          lastErr = err;
          logger.warn('ledger.conflict_retry', { path, attempt });
          await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new GraphError('Too many write conflicts', 'conflict');
  }

  private async appendOnce(path: string, rows: LedgerRow[]): Promise<AppendResult> {
    const remote = await this.drive.download(path);

    if (!remote) {
      // ONLY a genuine 404 reaches here, so a 403/5xx can never cause an overwrite.
      const wb = createWorkbook(this.currency);
      const added = appendRows(wb, rows);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      await this.drive.upload(path, buf, { failIfExists: true });
      logger.info('ledger.created', { path, added });
      return { created: true, added, skippedDuplicates: rows.length - added };
    }

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(remote.data);
    } catch (err) {
      throw new LedgerCorruptError(
        `Existing ledger could not be parsed (${err instanceof Error ? err.message : 'unknown'}); refusing to overwrite`,
      );
    }
    const added = appendRows(wb, rows);
    if (added === 0) return { created: false, added: 0, skippedDuplicates: rows.length };

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await this.drive.upload(path, buf, { ifMatch: remote.eTag });
    return { created: false, added, skippedDuplicates: rows.length - added };
  }
}
