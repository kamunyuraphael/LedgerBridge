import { randomUUID } from 'node:crypto';
import { Schema, model, type InferSchemaType } from 'mongoose';

export const SYNC_STATUSES = ['pending', 'processing', 'synced', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

const saleRecordSchema = new Schema(
  {
    recordId: { type: String, required: true, unique: true, default: () => randomUUID() },
    storeCode: { type: String, required: true, uppercase: true, trim: true },
    sku: { type: String, required: true, trim: true },
    unitsSold: { type: Number, required: true, min: 1, validate: Number.isInteger },
    /** Money is stored as integer cents to avoid floating-point drift. */
    totalRevenueCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    /** Authoritative server-side timestamp. */
    timestamp: { type: Date, required: true, default: () => new Date() },
    clientSubmittedAt: { type: Date },

    syncStatus: { type: String, enum: SYNC_STATUSES, default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedAt: { type: Date },
    lastError: { type: String },
    syncedAt: { type: Date },
    ledgerFile: { type: String },
  },
  { timestamps: true },
);

saleRecordSchema.index({ syncStatus: 1, nextAttemptAt: 1, timestamp: 1 });

export type SaleRecordDoc = InferSchemaType<typeof saleRecordSchema>;
export const SaleRecord = model('SaleRecord', saleRecordSchema);
