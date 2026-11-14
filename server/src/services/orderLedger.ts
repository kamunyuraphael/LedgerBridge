import { GraphError } from './graph/types';
import {
  CELL_FORMATS,
  colLetter,
  toSerialDate,
  type ColumnFormat,
  type SheetsApi,
  type TabLayout,
} from './googleSheetsLedger';
import { STATUS_LABELS, type OrderStatus } from './orderLogic';
import { logger } from '../utils/logger';

export const ORDER_HEADER = ['Approved (EAT)', 'Order No.', 'PO No.', 'Branch', 'Supplier', 'Status', 'Record ID'];
export const ORDER_LAYOUT: TabLayout = { headerCols: 7, visibleCols: 6, widths: [150, 150, 120, 170, 280, 140] };
const RECORD_ID_COL = 6;
const PO_COL = 2;
const STATUS_COL = 5;

const ORDER_FORMATS: readonly ColumnFormat[] = [
  CELL_FORMATS[0]!, // date-time
  { horizontalAlignment: 'LEFT' },
  { numberFormat: { type: 'TEXT', pattern: '@' }, horizontalAlignment: 'CENTER' },
  { horizontalAlignment: 'LEFT' },
  { horizontalAlignment: 'LEFT' },
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
}

export interface OrderLedgerSink {
  sync(tab: string, order: OrderLedgerRow): Promise<{ created: boolean; added: number; updated: number }>;
}

const EAT_MS = 3 * 3600_000;
/** Spreadsheet date-times carry no zone, so store Nairobi wall-clock time. */
const eatSerial = (d: Date): number => toSerialDate(new Date(d.getTime() + EAT_MS));

/** "Orders_2026-11" by the approval month in Nairobi time. */
export function orderTabFor(prefix: string, approvedAt: Date): string {
  const d = new Date(approvedAt.getTime() + EAT_MS);
  return `${prefix}_${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Keeps one Google Sheet tab per month with one row per order (branch + supplier). Idempotent: the row is
 * matched by a hidden Record ID (the order number). Re-syncing only refreshes the PO number and status
 * cells, so the sheet always shows the latest state without duplicating rows.
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
    const row = ids.findIndex((id) => id === o.orderNo);
    const statusText = STATUS_LABELS[o.status];
    const po = o.poNumber ?? '';
    if (row === -1) {
      await this.api.appendRows(sheetId, [[eatSerial(o.approvedAt), o.orderNo, po, o.branchName, o.supplierName, statusText, o.orderNo]], ORDER_FORMATS);
      return { created, added: 1, updated: 0 };
    }
    await this.api.updateCells(tab, [
      { row: row + 2, col: PO_COL, value: po },
      { row: row + 2, col: STATUS_COL, value: statusText },
    ]);
    return { created, added: 0, updated: 1 };
  }
}

export const ORDER_RECORD_ID_LETTER = colLetter(RECORD_ID_COL);
