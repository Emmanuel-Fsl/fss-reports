'use client'

import type { ColumnDef } from '@/types'
import clsx               from 'clsx'

interface Props {
  extraColumns: ColumnDef[]
  activeExtra:  Set<string>
  onToggle:     (key: string) => void
}

export default function ColumnToggleBar({ extraColumns, activeExtra, onToggle }: Props) {
  return (
    <div className="flex flex-shrink-0 items-center gap-2.5 overflow-x-auto border-b border-gray-200 bg-gray-50 px-7 py-2.5">
      <span className="mr-1 flex-shrink-0 text-[11px] font-bold uppercase tracking-widest text-gray-300">
        Extra columns
      </span>

      {extraColumns.length === 0 && (
        <span className="text-[11px] text-gray-300">None for this report</span>
      )}

      {extraColumns.map(col => (
        <button
          key={col.key}
          onClick={() => onToggle(col.key)}
          className={clsx(
            'flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-all',
            activeExtra.has(col.key)
              ? 'border-[#2E7D32] bg-[#E8F5E9] text-[#1B5E20]'
              : 'border-gray-200 bg-white text-gray-400 hover:border-[#2E7D32] hover:text-[#2E7D32]'
          )}
        >
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              activeExtra.has(col.key) ? 'bg-[#2E7D32]' : 'bg-gray-300'
            )}
          />
          {col.label}
        </button>
      ))}
    </div>
  )
}
