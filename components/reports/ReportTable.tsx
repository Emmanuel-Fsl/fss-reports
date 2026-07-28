'use client'

import { useState } from 'react'
import { FaSort, FaSortDown, FaSortUp } from 'react-icons/fa'
import type { ReportRow, ColumnDef } from '@/types'
import clsx from 'clsx'

interface Props {
  rows: ReportRow[]
  columns: ColumnDef[]
  /** Optional per-row currency symbol override (defaults to NGN). */
  getCurrencySymbol?: (row: ReportRow) => string
}

function fmtAmount(val: string | number | null): string {
  if (val === null || val === undefined) return '-'
  const n = parseFloat(String(val).replace(/,/g, ''))
  if (isNaN(n)) return String(val)
  return n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-light text-[#2E7D32]',
  settled: 'bg-blue-50 text-blue-700',
  pending: 'bg-yellow-50 text-yellow-700',
  overdue: 'bg-red-50 text-red-700',
}

export default function ReportTable({ rows, columns, getCurrencySymbol }: Props) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<1 | -1>(1)

  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => (d === 1 ? -1 : 1))
    else {
      setSortKey(key)
      setSortDir(1)
    }
  }

  const sorted = [...rows].sort((a, b) => {
    if (!sortKey) return 0
    const av = a[sortKey] ?? ''
    const bv = b[sortKey] ?? ''
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sortDir
  })

  function renderCell(col: ColumnDef, row: ReportRow) {
    const val = row[col.key] ?? '-'

    switch (col.type) {
      case 'mono':
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-gray-400">
            {String(val)}
          </td>
        )
      case 'currency': {
        const sym = getCurrencySymbol ? getCurrencySymbol(row) : 'NGN'
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5 text-right font-sans text-[12.5px] font-semibold text-[#1B5E20]">
            {sym} {fmtAmount(val)}
          </td>
        )
      }
      case 'num':
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5 text-right font-sans text-[12.5px] text-gray-600">
            {String(val)}
          </td>
        )
      case 'badge':
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5">
            <span className="rounded px-2 py-0.5 text-[10.5px] font-bold bg-gray-100 text-gray-500">
              {String(val)}
            </span>
          </td>
        )
      case 'status': {
        const s = String(val).toLowerCase()
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5">
            <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS_STYLES[s] ?? 'bg-gray-100 text-gray-500')}>
              {String(val)}
            </span>
          </td>
        )
      }
      default:
        return (
          <td key={col.key} className="whitespace-nowrap px-4 py-2.5 text-[13px] text-gray-800">
            {String(val)}
          </td>
        )
    }
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {columns.map(col => (
            <th
              key={col.key}
              onClick={() => handleSort(col.key)}
              className={clsx(
                'sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b-2 border-gray-200 bg-white px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-gray-400 hover:text-[#2E7D32]',
                col.type === 'currency' || col.type === 'num' ? 'text-right' : '',
              )}
            >
              {col.label}
              {sortKey === col.key
                ? (sortDir === 1
                    ? <FaSortUp className="ml-1 inline-block text-[10px] text-[#2E7D32]" />
                    : <FaSortDown className="ml-1 inline-block text-[10px] text-[#2E7D32]" />)
                : <FaSort className="ml-1 inline-block text-[10px] opacity-30" />}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => (
          <tr
            key={i}
            className="border-b border-gray-100 transition-colors hover:bg-[#E8F5E9]"
          >
            {columns.map(col => renderCell(col, row))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
