import ExcelJS from 'exceljs';
import { Branch, Item, Replenishment, Supplier } from '../models/catalog';

export type ImportKind = 'suppliers' | 'items' | 'branches' | 'quantities';

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
  items: {
    itemNo: ['itemno', 'item', 'itemcode', 'code', 'sku'],
    description: ['description', 'itemdescription', 'name'],
    supplierCode: ['supplierno', 'suppliercode', 'supplier', 'vendorno', 'vendorcode', 'vendor'],
  },
  branches: { code: ['code', 'no', 'branchcode', 'storecode'], name: ['name', 'branchname', 'store', 'storename'] },
  quantities: {
    branchCode: ['branchcode', 'storecode', 'branch', 'store', 'code', 'location', 'locationcode'],
    itemNo: ['itemno', 'item', 'itemcode', 'sku'],
    qty: ['qty', 'quantity', 'orderqty', 'orderquantity', 'replenishmentqty', 'standardqty', 'reorderqty'],
  },
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

const defaultQtyOf = (r: Record<string, string>): { defaultQty?: number } => {
  const n = Math.round(Number(r.defaultQty));
  return Number.isFinite(n) && n >= 1 ? { defaultQty: n } : {};
};

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

export async function importRows(kind: ImportKind, rows: Record<string, string>[]): Promise<ImportResult> {
  const result: ImportResult = { kind, received: rows.length, written: 0, errors: [] };
  const fail = (row: string, message: string) => result.errors.push({ row, message });

  if (kind === 'suppliers' || kind === 'branches') {
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

  if (kind === 'quantities') {
    const branches = new Set((await Branch.find({}, { code: 1 }).lean()).map((b) => b.code));
    const itemSet = new Set((await Item.find({}, { itemNo: 1 }).lean()).map((i) => i.itemNo));
    const ops: { updateOne: { filter: { branchCode: string; itemNo: string }; update: object; upsert: true } }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const branchCode = (r.branchCode ?? '').toUpperCase();
      const itemNo = (r.itemNo ?? '').toUpperCase();
      const qty = Number((r.qty ?? '').replace(/,/g, ''));
      if (!branches.has(branchCode)) {
        fail(r._row ?? '?', `unknown branch "${branchCode}" (import branches first)`);
        continue;
      }
      if (!itemSet.has(itemNo)) {
        fail(r._row ?? '?', `unknown item "${itemNo}" (import products first)`);
        continue;
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) {
        fail(r._row ?? '?', `quantity must be a whole number from 1 to 100000 (got "${r.qty ?? ''}")`);
        continue;
      }
      const key = `${branchCode}|${itemNo}`;
      if (seen.has(key)) {
        fail(r._row ?? '?', `duplicate ${branchCode} / ${itemNo} in file`);
        continue;
      }
      seen.add(key);
      ops.push({ updateOne: { filter: { branchCode, itemNo }, update: { $set: { qty, simulated: false }, $setOnInsert: { branchCode, itemNo } }, upsert: true } });
    }
    if (ops.length) {
      const res = await Replenishment.bulkWrite(ops);
      result.written = res.upsertedCount + res.matchedCount;
    }
    return result;
  }

  const suppliers = new Set((await Supplier.find({}, { code: 1 }).lean()).map((s) => s.code));
  const ops: Parameters<typeof Item.bulkWrite>[0] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const itemNo = (r.itemNo ?? '').toUpperCase();
    const supplierCode = (r.supplierCode ?? '').toUpperCase();
    const description = r.description ?? '';
    if (!CODE.test(itemNo) || !description) {
      fail(r._row ?? '?', 'needs a valid item number and a description');
      continue;
    }
    if (!suppliers.has(supplierCode)) {
      fail(r._row ?? '?', `unknown supplier "${supplierCode}" (import suppliers first)`);
      continue;
    }
    if (seen.has(itemNo)) {
      fail(r._row ?? '?', `duplicate item ${itemNo} in file`);
      continue;
    }
    seen.add(itemNo);
    ops.push({
      updateOne: { filter: { itemNo }, update: { $set: { description, supplierCode, active: true, simulated: false, ...defaultQtyOf(r) }, $setOnInsert: { itemNo } }, upsert: true },
    });
  }
  if (ops.length) {
    const res = await Item.bulkWrite(ops);
    result.written = res.upsertedCount + res.matchedCount;
  }
  return result;
}
