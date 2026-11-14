import { Schema, model } from 'mongoose';

const branchSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    /** True for generated demo rows; "Remove demo data" deletes only these. */
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Branch = model('Branch', branchSchema);

const supplierSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Supplier = model('Supplier', supplierSchema);

const itemSchema = new Schema(
  {
    itemNo: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, required: true, trim: true },
    supplierCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    /** Usual order quantity; used only for branches that have no replenishment rules of their own yet. */
    defaultQty: { type: Number, min: 1 },
    active: { type: Boolean, default: true },
    /** True for generated demo rows; "Remove demo data" deletes only these. */
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Item = model('Item', itemSchema);

/**
 * Standard replenishment quantity for one item at one branch, supplied by HQ (stand-in for the D365
 * planning result). A branch can only order items it has a rule for; the branch never types a quantity.
 */
const replenishmentSchema = new Schema(
  {
    branchCode: { type: String, required: true, uppercase: true, trim: true },
    itemNo: { type: String, required: true, uppercase: true, trim: true },
    qty: { type: Number, required: true, min: 1 },
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true },
);
replenishmentSchema.index({ branchCode: 1, itemNo: 1 }, { unique: true });
export const Replenishment = model('Replenishment', replenishmentSchema);
