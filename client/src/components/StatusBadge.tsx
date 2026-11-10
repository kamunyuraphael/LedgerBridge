import type { SyncStatus } from '../api/sales'

const LABEL: Record<SyncStatus, string> = {
  pending: 'Queued',
  processing: 'Syncing',
  synced: 'In ledger',
  failed: 'Needs attention',
}

const STYLE: Record<SyncStatus, string> = {
  pending: 'bg-[#fbf1d6] text-[#855a0a]',
  processing: 'bg-[#fbf1d6] text-[#855a0a]',
  synced: 'bg-[#e2f2e7] text-[#176044]',
  failed: 'bg-[#f8e1de] text-[#aa3e35]',
}

export function StatusBadge({ status }: { status: SyncStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STYLE[status]}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${status === 'pending' || status === 'processing' ? 'animate-pulse' : ''}`}
      />
      {LABEL[status]}
    </span>
  )
}
