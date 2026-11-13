import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { OrderStatus } from '../api/types'

const STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  submitted: { label: 'Awaiting approval', cls: 'bg-[#fbf1d6] text-[#855a0a]' },
  approved: { label: 'Approved', cls: 'bg-[#e2f2e7] text-[#176044]' },
  sent: { label: 'Sent to supplier', cls: 'bg-[#e0ecf8] text-[#1f4f80]' },
  fulfilled: { label: 'Fulfilled', cls: 'bg-[#d4ecdb] text-[#0f5132]' },
  rejected: { label: 'Rejected', cls: 'bg-[#f8e1de] text-[#aa3e35]' },
  cancelled: { label: 'Cancelled', cls: 'bg-[#e9ebe9] text-[#5b645e]' },
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${STATUS[status].cls}`}>
      {STATUS[status].label}
    </span>
  )
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
const VARIANT: Record<Variant, string> = {
  primary: 'bg-[#064e3b] text-white hover:bg-[#0a5d48] disabled:bg-[#9db5ab]',
  secondary: 'border border-[#d9ded9] bg-white text-[#18221d] hover:bg-[#f3f5f1] disabled:text-[#a7aea9]',
  danger: 'bg-[#aa3e35] text-white hover:bg-[#933029] disabled:bg-[#d9a9a4]',
  ghost: 'text-[#064e3b] hover:bg-[#e8f0eb] disabled:text-[#a7aea9]',
}
export function Button({
  variant = 'primary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={`inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-[#e4e8e4] bg-white p-5 shadow-sm ${className}`}>{children}</div>
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-[#e8bcb7] bg-[#fbeceb] px-4 py-3 text-sm text-[#8a2f27]">
      {children}
    </div>
  )
}
export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-[#bfdccb] bg-[#eaf5ee] px-4 py-3 text-sm text-[#176044]">{children}</div>
}

export function TextInput({ className = '', ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`h-10 w-full min-w-0 rounded-xl border border-[#d9ded9] bg-white px-3 text-sm outline-none focus:border-[#3b7c64] focus:ring-3 focus:ring-[#237355]/10 ${className}`}
    />
  )
}
