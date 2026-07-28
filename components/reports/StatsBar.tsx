'use client'

import { useMemo }        from 'react'
import type { ReportRow } from '@/types'

const KES_INSTITUTIONS = new Set(['NUMIDA', 'PEZESHA'])

interface Props {
  rows:     ReportRow[]
  currency: 'NGN' | 'KES'
  fxRate:   number
}

function parseMoney(val: string | number | null): number {
  if (val === null || val === undefined) return 0
  return parseFloat(String(val).replace(/,/g, '')) || 0
}

function convertAmount(amount: number, institution: string, currency: 'NGN' | 'KES', fxRate: number): number {
  const isKes = KES_INSTITUTIONS.has(institution)
  if (isKes && currency === 'NGN') return amount * fxRate
  if (!isKes && currency === 'KES') return amount / fxRate
  return amount
}

function fmt(n: number, currency: 'NGN' | 'KES'): string {
  const sym = currency === 'KES' ? 'KSh' : '₦'
  return sym + ' ' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function StatsBar({ rows, currency, fxRate }: Props) {
  const stats = useMemo(() => {
    const recovered = rows.reduce((s, r) =>
      s + convertAmount(parseMoney(r.amount_recovered as string), String(r.institution ?? ''), currency, fxRate), 0)
    const assigned = rows.reduce((s, r) =>
      s + convertAmount(parseMoney(r.assigned_amount as string), String(r.institution ?? ''), currency, fxRate), 0)
    const rate = assigned > 0 ? ((recovered / assigned) * 100).toFixed(1) + '%' : '—'
    return { borrowers: rows.length, recovered, assigned, rate }
  }, [rows, currency, fxRate])

  const items = [
    { label: 'Borrowers',       value: String(stats.borrowers),          green: false },
    { label: 'Total Recovered', value: fmt(stats.recovered, currency),   green: true  },
    { label: 'Total Assigned',  value: fmt(stats.assigned, currency),    green: false },
    { label: 'Recovery Rate',   value: stats.rate,                       green: true  },
  ]

  return (
    <div className="flex flex-shrink-0 items-center gap-6 border-b border-gray-200 bg-white px-7 py-3">
      {items.map((item, i) => (
        <div key={item.label} className="flex items-center gap-6">
          {i > 0 && <div className="h-8 w-px bg-gray-200" />}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              {item.label}
            </span>
            <span
              className="font-sans text-lg font-bold tracking-tight"
              style={{ color: item.green ? '#2E7D32' : '#111827' }}
            >
              {item.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
