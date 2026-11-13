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
    active: { type: Boolean, default: true },
    /** True for generated demo rows; "Remove demo data" deletes only these. */
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Item = model('Item', itemSchema);
