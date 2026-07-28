'use client'

import type { ReportConfig, ReportFilters } from '@/types'

interface Props {
  report:       ReportConfig
  filters:      ReportFilters
  onChange:     (f: ReportFilters) => void
  institutions: readonly string[]
}

const inputCls = `
  rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px]
  text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2
  focus:ring-[#2E7D32]/10 w-full cursor-pointer font-[var(--font-sans)]
`

const labelCls = 'text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5 block'

export default function FilterBar({ report, filters, onChange, institutions }: Props) {
  function set(key: keyof ReportFilters, value: string) {
    onChange({ ...filters, [key]: value })
  }

  return (
    <div className="flex-shrink-0 border-b border-gray-200 bg-white px-7 py-4">
      <div className="flex items-end gap-6">

        {report.filters.includes('institution') && (
          <div className="flex w-56 flex-col">
            <label className={labelCls}>Institution</label>
            <select
              value={filters.institution ?? ''}
              onChange={e => set('institution', e.target.value)}
              className={inputCls}
            >
              <option value="">All Institutions</option>
              {institutions.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        )}

        {(report.filters.includes('dateFrom') || report.filters.includes('dateTo')) && (
          <>
            <div className="h-9 w-px self-end bg-gray-200" />
            <div className="flex flex-col">
              <label className={labelCls}>Date Range</label>
              <div className="flex items-end gap-3">
                {report.filters.includes('dateFrom') && (
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">From</span>
                    <input
                      type="date"
                      value={filters.dateFrom ?? ''}
                      onChange={e => set('dateFrom', e.target.value)}
                      className="rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10 cursor-pointer w-40"
                    />
                  </div>
                )}
                <span className="mb-2 select-none text-sm text-gray-300">→</span>
                {report.filters.includes('dateTo') && (
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">To</span>
                    <input
                      type="date"
                      value={filters.dateTo ?? ''}
                      onChange={e => set('dateTo', e.target.value)}
                      className="rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10 cursor-pointer w-40"
                    />
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {report.filters.includes('status') && (
          <>
            <div className="h-9 w-px self-end bg-gray-200" />
            <div className="flex w-40 flex-col">
              <label className={labelCls}>Status</label>
              <select
                value={filters.status ?? ''}
                onChange={e => set('status', e.target.value)}
                className={inputCls}
              >
                {['All Statuses', 'Active', 'Pending', 'Overdue', 'Settled'].map(v => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {report.filters.includes('agent') && (
          <>
            <div className="h-9 w-px self-end bg-gray-200" />
            <div className="flex w-44 flex-col">
              <label className={labelCls}>Agent</label>
              <input
                type="text"
                placeholder="All agents"
                value={filters.agent ?? ''}
                onChange={e => set('agent', e.target.value)}
                className={inputCls}
              />
            </div>
          </>
        )}

      </div>
    </div>
  )
}