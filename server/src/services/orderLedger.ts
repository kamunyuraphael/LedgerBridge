import { GraphError } from './graph/types';
import {
  CELL_FORMATS,
  colLetter,
  toSerialDate,
  type ColumnFormat,
  type SheetsApi,
  type TabLayout,
} from './googleSheetsLedger';
import { STATUS_LABELS, type OrderLine, type OrderStatus } from './orderLogic';
import { logger } from '../utils/logger';

export const ORDER_HEADER = [
  'Approved (EAT)',
  'Order No.',
  'PO No.',
  'Branch',
  'Supplier',
  'Item No.',
  'Description',
  'Qty',
  'Status',
  'Record ID',
];
export const ORDER_LAYOUT: TabLayout = { headerCols: 10, visibleCols: 9, widths: [150, 150, 120, 170, 200, 100, 320, 70, 130] };
const RECORD_ID_COL = 9;
const PO_COL = 2;
const STATUS_COL = 8;

const ORDER_FORMATS: readonly ColumnFormat[] = [
  CELL_FORMATS[0]!, // date-time
  { horizontalAlignment: 'LEFT' },
  { numberFormat: { type: 'TEXT', pattern: '@' }, horizontalAlignment: 'CENTER' },
  { horizontalAlignment: 'LEFT' },
  { horizontalAlignment: 'LEFT' },
  { numberFormat: { type: 'TEXT', pattern: '@' }, horizontalAlignment: 'LEFT' },
  { horizontalAlignment: 'LEFT' },
  { numberFormat: { type: 'NUMBER', pattern: '#,##0' }, horizontalAlignment: 'RIGHT' },
  { horizontalAlignment: 'CENTER' },
  { horizontalAlignment: 'LEFT' },
];

export interface OrderLedgerRow {
  orderNo: string;
  approvedAt: Date;
  poNumber?: string | undefined;
  branchName: string;
  supplierName: string;
  status: OrderStatus;
  lines: OrderLine[];
}

export interface OrderLedgerSink {
  sync(tab: string, order: OrderLedgerRow): Promise<{ created: boolean; added: number; updated: number }>;
}

export const rowId = (orderNo: string, itemNo: string): string => `${orderNo}:${itemNo}`;
const EAT_MS = 3 * 3600_000;
/** Spreadsheet date-times carry no zone, so store Nairobi wall-clock time. */
const eatSerial = (d: Date): number => toSerialDate(new Date(d.getTime() + EAT_MS));

/** "Orders_2026-11" by the approval month in Nairobi time. */
export function orderTabFor(prefix: string, approvedAt: Date): string {
  const d = new Date(approvedAt.getTime() + EAT_MS);
  return `${prefix}_${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Keeps one Google Sheet tab per month with a row per order line. Idempotent: lines are matched by a
 * hidden Record ID (orderNo:itemNo). Re-syncing an order only refreshes its PO number and status cells,
 * so the sheet always shows the latest state without duplicating rows.
 */
export class GoogleSheetsOrderLedger implements OrderLedgerSink {
  constructor(private readonly api: SheetsApi) {}

  async sync(tab: string, o: OrderLedgerRow) {
    let created = false;
    let sheetId = (await this.api.listTabs()).get(tab);
    if (sheetId === undefined) {
      const newId = await this.api.createTab(tab, ORDER_HEADER.length);
      if (newId !== null) {
        await this.api.writeHeader(tab, ORDER_HEADER);
        await this.api.formatLedgerTab(newId, ORDER_LAYOUT);
        created = true;
        sheetId = newId;
        logger.info('orders.tab_created', { tab });
      } else {
        sheetId = (await this.api.listTabs()).get(tab);
      }
    }
    if (sheetId === undefined) throw new GraphError(`Could not find or create tab "${tab}"`, 'transient');

    const ids = await this.api.readColumn(tab, RECORD_ID_COL);
    const rowOf = new Map<string, number>();
    ids.forEach((id, i) => {
      if (id) rowOf.set(id, i + 2);
    });

    const statusText = STATUS_LABELS[o.status];
    const po = o.poNumber ?? '';
    const fresh = o.lines.filter((l) => !rowOf.has(rowId(o.orderNo, l.itemNo)));
    if (fresh.length) {
      await this.api.appendRows(
        sheetId,
        fresh.map((l) => [eatSerial(o.approvedAt), o.orderNo, po, o.branchName, o.supplierName, l.itemNo, l.description, l.qty, statusText, rowId(o.orderNo, l.itemNo)]),
        ORDER_FORMATS,
      );
    }

    const updates: { row: number; col: number; value: string }[] = [];
    for (const l of o.lines) {
      const row = rowOf.get(rowId(o.orderNo, l.itemNo));
      if (row === undefined) continue;
      updates.push({ row, col: PO_COL, value: po }, { row, col: STATUS_COL, value: statusText });
    }
    await this.api.updateCells(tab, updates);
    return { created, added: fresh.length, updated: updates.length / 2 };
  }
}

export const ORDER_RECORD_ID_LETTER = colLetter(RECORD_ID_COL);
