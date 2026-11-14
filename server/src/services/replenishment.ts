import { Item, Replenishment } from '../models/catalog';

/**
 * What a branch may order, with the standard quantity for each item.
 * A branch with replenishment rules gets exactly those items; a branch with none yet falls back to the
 * items' default quantities so a newly added branch is not stuck with an empty screen.
 */
export async function orderableFor(branchCode: string): Promise<Map<string, number>> {
  const rules = await Replenishment.find({ branchCode: branchCode.toUpperCase() }, { itemNo: 1, qty: 1 }).lean();
  if (rules.length > 0) {
    const active = new Set((await Item.find({ itemNo: { $in: rules.map((r) => r.itemNo) }, active: true }, { itemNo: 1 }).lean()).map((i) => i.itemNo));
    return new Map(rules.filter((r) => active.has(r.itemNo)).map((r) => [r.itemNo, r.qty]));
  }
  const defaults = await Item.find({ active: true, defaultQty: { $gte: 1 } }, { itemNo: 1, defaultQty: 1 }).lean();
  return new Map(defaults.map((i) => [i.itemNo, i.defaultQty as number]));
}
