import { Schema, model } from 'mongoose';

const historySchema = new Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: String, required: true },
    note: { type: String },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true },
    /** Client-generated UUID for the whole basket; with branch+supplier it makes submits idempotent. */
    requestId: { type: String, required: true },
    branchCode: { type: String, required: true, index: true },
    branchName: { type: String, required: true },
    supplierCode: { type: String, required: true },
    supplierName: { type: String, required: true },
    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected', 'sent', 'fulfilled', 'cancelled'],
      default: 'submitted',
    },
    note: { type: String },
    rejectionReason: { type: String },
    /** Purchase-order number from HQ's PDF/PO system, entered after approval. */
    poNumber: { type: String },
    history: { type: [historySchema], default: [] },
    createdBy: { type: String, required: true },
    /** When HQ approved the order (drives which ledger tab it lands in). */
    approvedAt: { type: Date },
    /** Ledger (Google Sheet) sync state. Absent until the order is first approved. */
    ledgerStatus: { type: String, enum: ['pending', 'processing', 'synced', 'failed'] },
    /** Bumped on every re-queue so a sync that started before a later change can't mark it done. */
    ledgerRev: { type: Number, default: 0 },
    ledgerAttempts: { type: Number, default: 0 },
    ledgerNextAt: { type: Date },
    ledgerLockedAt: { type: Date },
    ledgerError: { type: String },
    ledgerSyncedAt: { type: Date },
  },
  { timestamps: true },
);
orderSchema.index({ branchCode: 1, requestId: 1, supplierCode: 1 }, { unique: true });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ supplierCode: 1, status: 1 });
orderSchema.index({ ledgerStatus: 1, ledgerNextAt: 1 });
orderSchema.index({ poNumber: 1 }, { unique: true, partialFilterExpression: { poNumber: { $type: 'string' } } });
export const Order = model('Order', orderSchema);

const counterSchema = new Schema({ _id: { type: String }, seq: { type: Number, default: 0 } });
export const Counter = model('Counter', counterSchema);
