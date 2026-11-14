import ExcelJS from 'exceljs';
import { Branch, Supplier } from '../models/catalog';

export type ImportKind = 'suppliers' | 'branches';

export interface ImportResult {
  kind: ImportKind;
  received: number;
  written: number;
  errors: { row: string; message: string }[];
}

const norm = (v: unknown): string => String(v ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const key = (v: unknown): string => norm(v).toLowerCase().replace(/[^a-z0-9]/g, '');

const SYNONYMS: Record<ImportKind, Record<string, string[]>> = {
  suppliers: { code: ['no', 'code', 'vendorno', 'vendorcode', 'suppliercode', 'supplierno'], name: ['name', 'vendorname', 'suppliername'] },
  branches: { code: ['code', 'no', 'branchcode', 'storecode'], name: ['name', 'branchname', 'store', 'storename'] },
};

/** Read every sheet; a sheet counts if a header row (within its first 5 rows) has all required columns. */
export async function readTable(buffer: Buffer, kind: ImportKind): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const wanted = SYNONYMS[kind];
  const rows: Record<string, string>[] = [];
  for (const ws of wb.worksheets) {
    let colOf: Record<string, number> | null = null;
    let headerRow = 0;
    for (let r = 1; r <= Math.min(5, ws.rowCount) && !colOf; r++) {
      const found: Record<string, number> = {};
      ws.getRow(r).eachCell((cell, c) => {
        const k = key(cell.text);
        for (const [field, names] of Object.entries(wanted)) {
          if (found[field] === undefined && names.includes(k)) found[field] = c;
        }
      });
      if (Object.keys(found).length === Object.keys(wanted).length) {
        colOf = found;
        headerRow = r;
      }
    }
    if (!colOf) continue;
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rec: Record<string, string> = { _row: `${ws.name}!${r}` };
      let any = false;
      for (const [field, c] of Object.entries(colOf)) {
        rec[field] = norm(row.getCell(c).text);
        if (rec[field]) any = true;
      }
      if (any) rows.push(rec);
    }
  }
  return rows;
}

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

export async function importRows(kind: ImportKind, rows: Record<string, string>[]): Promise<ImportResult> {
  const result: ImportResult = { kind, received: rows.length, written: 0, errors: [] };
  const fail = (row: string, message: string) => result.errors.push({ row, message });

  const ops: { updateOne: { filter: { code: string }; update: object; upsert: true } }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const code = (r.code ?? '').toUpperCase();
    const name = r.name ?? '';
    if (!CODE.test(code) || !name) {
      fail(r._row ?? '?', 'needs a valid code and a name');
      continue;
    }
    if (seen.has(code)) {
      fail(r._row ?? '?', `duplicate code ${code} in file`);
      continue;
    }
    seen.add(code);
    ops.push({ updateOne: { filter: { code }, update: { $set: { name, active: true, ...(kind === 'branches' ? { simulated: false } : {}) }, $setOnInsert: { code } }, upsert: true } });
  }
  if (ops.length) {
    const res = kind === 'suppliers' ? await Supplier.bulkWrite(ops) : await Branch.bulkWrite(ops);
    result.written = res.upsertedCount + res.matchedCount;
  }
  return result;
}
