'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { FiBarChart2, FiDownload, FiPlay, FiRotateCcw } from 'react-icons/fi'
import { getAuth }                     from 'firebase/auth'
import type { ReportConfig, ReportRow, ColumnDef, ReportFilters } from '@/types'
import { ALL_INSTITUTIONS }            from '@/lib/reports/reports.config'
import { downloadExcel, downloadPDF }  from '@/lib/reports/export'
import ReportTable                     from './ReportTable'
import FilterBar                       from './FilterBar'
import ColumnToggleBar                 from './ColumnToggleBar'
import StatsBar                        from './StatsBar'

const KES_INSTITUTIONS = new Set(['NUMIDA', 'PEZESHA'])

function parseMoney(val: string | number | null | undefined): number {
  return parseFloat(String(val ?? 0).replace(/,/g, '')) || 0
}

function convertAmount(amount: number, institution: string, currency: 'NGN' | 'KES', fxRate: number): number {
  const isKes = KES_INSTITUTIONS.has(institution)
  if (isKes && currency === 'NGN') return amount * fxRate
  if (!isKes && currency === 'KES') return amount / fxRate
  return amount
}

interface Props {
  report: ReportConfig
}

// ── Module-level cache — survives navigation within the session ───────────────
interface ReportSnapshot {
  rows:        ReportRow[]
  filters:     ReportFilters
  execMs:      number | null
  activeExtra: string[]
  fxRate:      number
}
const _cache: Record<string, ReportSnapshot> = {}

function defaultCurrency(institution: string): 'NGN' | 'KES' {
  return KES_INSTITUTIONS.has(institution) ? 'KES' : 'NGN'
}

export default function ReportView({ report }: Props) {
  const cached = _cache[report.id]

  const [filters, setFilters]           = useState<ReportFilters>(
    cached?.filters ?? { institution: '', dateFrom: '2026-04-01', dateTo: '2026-04-30' },
  )
  const [activeExtra, setActiveExtra]   = useState<Set<string>>(
    new Set(cached?.activeExtra ?? []),
  )
  const [rows, setRows]                 = useState<ReportRow[]>(cached?.rows ?? [])
  const [hasData, setHasData]           = useState(!!cached)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')
  const [execMs, setExecMs]             = useState<number | null>(cached?.execMs ?? null)
  const [fxRate, setFxRate]             = useState<number>(cached?.fxRate ?? 10.5)
  const [currency, setCurrency]         = useState<'NGN' | 'KES'>(
    defaultCurrency(cached?.filters?.institution ?? ''),
  )

  // Persist active-extra changes back to cache whenever they change
  useEffect(() => {
    if (_cache[report.id]) {
      _cache[report.id].activeExtra = [...activeExtra]
    }
  }, [activeExtra, report.id])

  const visibleColumns: ColumnDef[] = [
    ...report.coreColumns,
    ...report.extraColumns.filter(c => activeExtra.has(c.key)),
  ]

  // ── Run report ───────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const user    = getAuth().currentUser
      const token   = await user?.getIdToken()
      const res     = await fetch('/api/reports/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ bqKey: report.bqKey, filters }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data = await res.json()
      const rate = data.fxRate ?? 10.5
      setRows(data.rows)
      setExecMs(data.executionMs)
      setFxRate(rate)
      setCurrency(defaultCurrency(filters.institution ?? ''))
      setHasData(true)
      _cache[report.id] = {
        rows:        data.rows,
        filters,
        execMs:      data.executionMs,
        activeExtra: [...activeExtra],
        fxRate:      rate,
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [report.bqKey, filters])

  // Pre-transform currency columns for the recovery report table
  const displayRows = useMemo(() => {
    if (report.id !== 'recovery_report') return rows
    return rows.map(row => ({
      ...row,
      amount_recovered: convertAmount(parseMoney(row.amount_recovered), String(row.institution ?? ''), currency, fxRate),
      assigned_amount:  convertAmount(parseMoney(row.assigned_amount),  String(row.institution ?? ''), currency, fxRate),
    }))
  }, [rows, currency, fxRate, report.id])

  // ── Export ───────────────────────────────────────────────────────────────────
  async function handleExport(format: 'csv' | 'excel' | 'pdf') {
    if (!hasData) return

    const user  = getAuth().currentUser
    const token = await user?.getIdToken()
    const filename = `${report.id}_${filters.dateFrom ?? 'export'}`

    if (format === 'csv') {
      // Server streams CSV
      const res = await fetch('/api/reports/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          bqKey: report.bqKey,
          filters,
          columns: visibleColumns.map(c => c.key),
          format:  'csv',
          reportLabel: report.label,
        }),
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `${filename}.csv`; a.click()
      URL.revokeObjectURL(url)
      return
    }

    if (format === 'excel') {
      await downloadExcel(rows, visibleColumns, filename, report.label)
    }

    if (format === 'pdf') {
      await downloadPDF(rows, visibleColumns, filename, report.label, {
        Institution: filters.institution ?? '',
        From:        filters.dateFrom    ?? '',
        To:          filters.dateTo      ?? '',
      })
    }
  }

  // ── Toggle extra column ──────────────────────────────────────────────────────
  function toggleColumn(key: string) {
    setActiveExtra(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function resetFilters() {
    setFilters({ institution: '', dateFrom: '2026-04-01', dateTo: '2026-04-30' })
    setHasData(false)
    setRows([])
    delete _cache[report.id]
  }

  return (
    <div className="flex h-screen flex-col">

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-12">

      {/* Topbar */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-gray-900">{report.label}</h1>
          <p className="mt-0.5 text-xs text-gray-400">{report.desc}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetFilters}
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-semibold text-gray-400 transition hover:bg-gray-100"
          >
            <FiRotateCcw className="h-3 w-3" />
            Reset
          </button>
          <button
            onClick={runReport}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md bg-[#2E7D32] px-4 py-1.5 text-xs font-bold text-white transition hover:bg-[#1B5E20] disabled:opacity-60"
          >
            {loading ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : <FiPlay className="h-3 w-3" />}
            Run Report
          </button>
        </div>
      </div>

      {/* Filters */}
      <FilterBar
        report={report}
        filters={filters}
        onChange={setFilters}
        institutions={ALL_INSTITUTIONS}
      />

      {/* Stats (recovery report only) */}
      {hasData && report.id === 'recovery_report' && (
        <StatsBar rows={rows} currency={currency} fxRate={fxRate} />
      )}

      {/* Currency toggle + FX info bar (recovery report only) */}
      {hasData && report.id === 'recovery_report' && (
        <div className="flex flex-shrink-0 items-center justify-between border-b border-blue-100 bg-blue-50 px-7 py-2">
          <p className="text-xs text-blue-600">
            All amounts in <strong>{currency}</strong>
            <span className="ml-1.5 text-blue-400">
              {currency === 'NGN'
                ? `(1 KES ≈ ₦${fxRate.toFixed(2)})`
                : `(1 KES ≈ ₦${fxRate.toFixed(2)} · ₦1 ≈ ${(1 / fxRate).toFixed(4)} KES)`}
            </span>
          </p>
          <div className="flex rounded-md border border-blue-200 p-0.5">
            {(['NGN', 'KES'] as const).map(c => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={`rounded px-3 py-0.5 text-xs font-bold transition ${
                  currency === c ? 'bg-blue-600 text-white' : 'text-blue-500 hover:bg-blue-100'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Column toggles */}
      <ColumnToggleBar
        extraColumns={report.extraColumns}
        activeExtra={activeExtra}
        onToggle={toggleColumn}
      />

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}

      {/* Table / empty state */}
        {hasData ? (
          <div className="overflow-x-auto">
            <ReportTable
              rows={displayRows}
              columns={visibleColumns}
              getCurrencySymbol={() => currency === 'KES' ? 'KSh' : '₦'}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200 text-2xl">
              <FiBarChart2 className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-gray-500">No data loaded</p>
            <p className="text-xs">Select filters and click Run Report</p>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-[260px] right-0 z-10 flex items-center justify-between border-t border-gray-200 bg-white px-7 py-2.5">
        <p className="text-xs text-gray-400">
          {hasData ? (
            <>
              <strong className="text-gray-900">{rows.length}</strong> rows &nbsp;·&nbsp;
              <strong className="text-gray-900">{visibleColumns.length}</strong> columns
              {execMs != null && (
                <> &nbsp;·&nbsp; <span className="font-mono">{execMs}ms</span></>
              )}
              &nbsp;·&nbsp; <span className="font-mono text-[11px]">{report.bqKey}</span>
            </>
          ) : "-"}
        </p>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">
            Export as
          </span>
          {(['csv', 'excel', 'pdf'] as const).map(fmt => (
            <button
              key={fmt}
              onClick={() => handleExport(fmt)}
              disabled={!hasData}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FiDownload className="h-3 w-3" /> {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
