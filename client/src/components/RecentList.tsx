import type { SaleRecord } from '../api/sales'
import { CURRENCY } from '../config'
import { StatusBadge } from './StatusBadge'

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function RecentList({ records }: { records: SaleRecord[] }) {
  if (records.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[#d9ded9] px-4 py-6 text-center text-xs text-[#8a938c]">
        No transactions yet. Submitted sales will appear here.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-[#dbe4dc] bg-white">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[#e4e8e4] text-[10px] tracking-wide text-[#758078] uppercase">
            <th className="px-4 py-2.5 font-semibold">Time</th>
            <th className="px-2 py-2.5 font-semibold">Store</th>
            <th className="px-2 py-2.5 font-semibold">SKU</th>
            <th className="px-2 py-2.5 text-right font-semibold">Units</th>
            <th className="px-2 py-2.5 text-right font-semibold">Revenue ({CURRENCY})</th>
            <th className="px-4 py-2.5 font-semibold">Ledger</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.recordId} className="border-b border-[#eef1ee] last:border-0">
              <td className="px-4 py-2.5 whitespace-nowrap text-[#69736c]">
                {new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </td>
              <td className="px-2 py-2.5 font-semibold whitespace-nowrap">{r.storeCode}</td>
              <td className="px-2 py-2.5 font-mono whitespace-nowrap">{r.sku}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{r.unitsSold.toLocaleString()}</td>
              <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{money.format(r.totalRevenue)}</td>
              <td className="px-4 py-2.5 whitespace-nowrap" title={r.lastError ?? undefined}>
                <StatusBadge status={r.syncStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
