'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
import { FiDownload, FiFileText, FiPlay, FiRotateCcw, FiCalendar } from 'react-icons/fi'
import { getAuth }               from 'firebase/auth'
import type { ReportRow, ColumnDef, ReportFilters } from '@/types'
import { ALL_INSTITUTIONS }      from '@/lib/reports/reports.config'
import {
  BILLING_SUMMARY_CORE_COLUMNS,
  BILLING_SUMMARY_EXTRA_COLUMNS,
} from '@/lib/reports/billing'
import { downloadBillingExcel }  from '@/lib/reports/export'
import type { BillingSheet }     from '@/lib/reports/export'
import ReportTable               from './ReportTable'

// ─── Billing stats bar ────────────────────────────────────────────────────────
const KES_INSTITUTIONS = new Set(['NUMIDA', 'PEZESHA'])

function parseMoney(v: string | number | null): number {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0
}

function convertAmount(amount: number, institution: string, currency: 'NGN' | 'KES', fxRate: number): number {
  const isKes = KES_INSTITUTIONS.has(institution)
  if (isKes && currency === 'NGN') return amount * fxRate
  if (!isKes && currency === 'KES') return amount / fxRate
  return amount
}

function fmt(n: number, currency: 'NGN' | 'KES'): string {
  const sym = currency === 'KES' ? 'KSh ' : '₦ '
  return sym + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function BillingStatsBar({ rows, currency, fxRate }: { rows: ReportRow[]; currency: 'NGN' | 'KES'; fxRate: number }) {
  const stats = useMemo(() => {
    const cv = (val: string | number | null, inst: string) =>
      convertAmount(parseMoney(val), inst, currency, fxRate)
    return {
      recovered: rows.reduce((s, r) => s + cv(r.amount_recovered, String(r.institution ?? '')), 0),
      preWht:    rows.reduce((s, r) => s + cv(r.revenue_pre_wht,  String(r.institution ?? '')), 0),
      wht:       rows.reduce((s, r) => s + cv(r.wht_5pct,         String(r.institution ?? '')), 0),
      postWht:   rows.reduce((s, r) => s + cv(r.revenue_post_wht, String(r.institution ?? '')), 0),
    }
  }, [rows, currency, fxRate])

  const items = [
    { label: 'Amount Recovered', value: fmt(stats.recovered, currency), green: false },
    { label: 'Revenue Pre WHT',  value: fmt(stats.preWht,    currency), green: true  },
    { label: 'WHT (5%)',         value: fmt(stats.wht,       currency), green: false },
    { label: 'Revenue Post WHT', value: fmt(stats.postWht,   currency), green: true  },
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

const inputCls = `
  rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px]
  text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2
  focus:ring-[#2E7D32]/10 w-full cursor-pointer font-[var(--font-sans)]
`


type InstDates = Record<string, { dateFrom: string; dateTo: string }>

function fmtLastPayment(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const day  = d
  const ord  = day === 1 || day === 21 || day === 31 ? 'st'
             : day === 2 || day === 22             ? 'nd'
             : day === 3 || day === 23             ? 'rd'
             : 'th'
  const month = date.toLocaleString('en-US', { month: 'long' })
  return `${month} ${day}${ord}, ${y}`
}

// ── Module-level cache — survives navigation within the session ───────────────
interface BillingSnapshot {
  summaryRows:          ReportRow[]
  detailRows:           ReportRow[] | null
  filters:              ReportFilters
  ranInst:              string
  execMs:               number | null
  emptyWarn:            boolean
  showCustomDates:      boolean
  institutionDates:     InstDates
  excludedInstitutions: string[]
  fxRate:               number
}
let _billingCache: BillingSnapshot | null = null

const LAST_PAYMENT_KEY = 'fss_last_payment_dates'
function getLastPaymentCache(): Record<string, string> | null {
  try { const v = localStorage.getItem(LAST_PAYMENT_KEY); return v ? JSON.parse(v) : null }
  catch { return null }
}
function setLastPaymentCache(data: Record<string, string>) {
  try { localStorage.setItem(LAST_PAYMENT_KEY, JSON.stringify(data)) } catch {}
}
function clearLastPaymentCache() {
  try { localStorage.removeItem(LAST_PAYMENT_KEY) } catch {}
}

export default function BillingReportView() {
  const c = _billingCache

  const [filters, setFilters] = useState<ReportFilters>(
    c?.filters ?? { institution: '', dateFrom: '2026-04-01', dateTo: '2026-04-30' },
  )
  const [showCustomDates,       setShowCustomDates]       = useState(c?.showCustomDates  ?? false)
  const [institutionDates,      setInstitutionDates]      = useState<InstDates>(c?.institutionDates ?? {})
  const [excludedInstitutions,  setExcludedInstitutions]  = useState<Set<string>>(
    new Set(c?.excludedInstitutions ?? []),
  )
  const [loadingLastDates,      setLoadingLastDates]      = useState(false)
  const [lastPaymentDates,      setLastPaymentDates]      = useState<Record<string, string>>({})
  const [groomingSegment,  setGroomingSegment]  = useState<'all' | '90+' | '360+'>(
    c?.filters?.institution === 'GROOMING MFI' ? ((c?.filters as any).groomingMfiSegment ?? 'all') : 'all',
  )
  const [activeExtra,      setActiveExtra]      = useState<Set<string>>(new Set())
  const [summaryRows,      setSummaryRows]      = useState<ReportRow[]>(c?.summaryRows ?? [])
  const [detailRows,       setDetailRows]       = useState<ReportRow[] | null>(c?.detailRows ?? null)
  const [hasData,          setHasData]          = useState(!!c)
  const [loading,          setLoading]          = useState(false)
  const [exporting,        setExporting]        = useState(false)
  const [error,            setError]            = useState('')
  const [execMs,           setExecMs]           = useState<number | null>(c?.execMs ?? null)
  const [emptyWarn,        setEmptyWarn]        = useState(c?.emptyWarn ?? false)
  const [ranInst,          setRanInst]          = useState<string>(c?.ranInst ?? '')
  const [fxRate,           setFxRate]           = useState<number>(c?.fxRate ?? 10.5)
  const [currency,         setCurrency]         = useState<'NGN' | 'KES'>(
    KES_INSTITUTIONS.has(c?.filters?.institution ?? '') ? 'KES' : 'NGN',
  )

  const isSingleInst      = !!(ranInst.trim())
  const isAllMode         = !(filters.institution?.trim())
  const isGroomingMfi     = filters.institution === 'GROOMING MFI'

  // Reset segment when switching away from GROOMING MFI
  useEffect(() => {
    if (!isGroomingMfi) setGroomingSegment('all')
  }, [isGroomingMfi])

  // Pre-transform summary rows for the table
  const displaySummaryRows = useMemo(() =>
    summaryRows.map(row => {
      const inst = String(row.institution ?? '')
      const cv   = (val: string | number | null) => convertAmount(parseMoney(val), inst, currency, fxRate)
      return {
        ...row,
        amount_recovered: cv(row.amount_recovered),
        revenue_pre_wht:  cv(row.revenue_pre_wht),
        wht_5pct:         cv(row.wht_5pct),
        revenue_post_wht: cv(row.revenue_post_wht),
      }
    }),
    [summaryRows, currency, fxRate],
  )

  // ── Fetch last payment dates (runs on mount + after reset) ───────────────────
  const fetchLastPaymentDates = useCallback(async () => {
    setLoadingLastDates(true)
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const res   = await fetch('/api/reports/billing/last-payment-dates', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data: Record<string, string> = await res.json()
        setLastPaymentCache(data)
        setLastPaymentDates(data)
      }
    } catch {
      // silently ignore
    } finally {
      setLoadingLastDates(false)
    }
  }, [])

  // Pre-fill instantly from localStorage, then always fetch fresh in the background
  useEffect(() => {
    const cached = getLastPaymentCache()
    if (cached) setLastPaymentDates(cached)
    fetchLastPaymentDates()
  }, [fetchLastPaymentDates])

  // Pre-fill institution dates: From = global default, To = last payment date (or global default).
  function toggleCustomDates() {
    if (!showCustomDates) {
      const df      = filters.dateFrom ?? '2026-04-01'
      const fallDt  = filters.dateTo   ?? '2026-04-30'
      const cached  = getLastPaymentCache() ?? lastPaymentDates
      const init: InstDates = {}
      ALL_INSTITUTIONS.forEach(inst => {
        init[inst] = { dateFrom: df, dateTo: cached[inst] ?? fallDt }
      })
      setInstitutionDates(init)
    }
    setShowCustomDates(v => !v)
  }

  function setInstDate(inst: string, field: 'dateFrom' | 'dateTo', value: string) {
    setInstitutionDates(prev => ({
      ...prev,
      [inst]: { ...prev[inst], [field]: value },
    }))
  }

  function toggleExcluded(inst: string) {
    setExcludedInstitutions(prev => {
      const next = new Set(prev)
      next.has(inst) ? next.delete(inst) : next.add(inst)
      return next
    })
  }

  // ── Visible summary columns ──────────────────────────────────────────────────
  const visibleSummaryCols: ColumnDef[] = [
    ...BILLING_SUMMARY_CORE_COLUMNS,
    ...BILLING_SUMMARY_EXTRA_COLUMNS.filter(c => activeExtra.has(c.key)),
  ]

  // ── Run report ───────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    setEmptyWarn(false)
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const body: ReportFilters = { ...filters }
      if (isAllMode && showCustomDates && Object.keys(institutionDates).length > 0) {
        const filtered: InstDates = {}
        Object.entries(institutionDates).forEach(([inst, dates]) => {
          if (!excludedInstitutions.has(inst)) filtered[inst] = dates
        })
        body.institutionDates = filtered
      }
      if (excludedInstitutions.size > 0) {
        body.excludedInstitutions = [...excludedInstitutions]
      }
      if (filters.institution === 'GROOMING MFI') {
        body.groomingMfiSegment = groomingSegment
      }
      const res = await fetch('/api/reports/billing/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data      = await res.json()
      const summary   = data.summaryRows ?? []
      const detail    = data.detailRows  ?? null
      const ms        = data.executionMs
      const rate      = data.fxRate ?? 10.5
      const isEmpty   = summary.length === 0
      const inst      = filters.institution?.trim() ?? ''
      setSummaryRows(summary)
      setDetailRows(detail)
      setExecMs(ms)
      setFxRate(rate)
      setCurrency(KES_INSTITUTIONS.has(inst) ? 'KES' : 'NGN')
      setHasData(true)
      setEmptyWarn(isEmpty)
      setRanInst(inst)
      _billingCache = {
        summaryRows: summary, detailRows: detail, filters, ranInst: inst,
        execMs: ms, emptyWarn: isEmpty, showCustomDates, institutionDates,
        excludedInstitutions: [...excludedInstitutions], fxRate: rate,
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [filters, isAllMode, showCustomDates, institutionDates, groomingSegment])

  // ── Export ───────────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!hasData) return
    if (emptyWarn) {
      const confirmed = window.confirm(
        'There is no recovery data for the selected period. You are about to download a file with only headers. Continue?',
      )
      if (!confirmed) return
    }

    setExporting(true)
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const body: ReportFilters = { ...filters }
      if (isAllMode && showCustomDates && Object.keys(institutionDates).length > 0) {
        const filtered: InstDates = {}
        Object.entries(institutionDates).forEach(([inst, dates]) => {
          if (!excludedInstitutions.has(inst)) filtered[inst] = dates
        })
        body.institutionDates = filtered
      }
      if (excludedInstitutions.size > 0) {
        body.excludedInstitutions = [...excludedInstitutions]
      }
      if (filters.institution === 'GROOMING MFI') {
        body.groomingMfiSegment = groomingSegment
      }
      const res = await fetch('/api/reports/billing/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Export failed')
      const data = await res.json()

      const summarySheet: BillingSheet = {
        name: 'Summary',
        rows: data.summary.rows,
        cols: data.summary.cols,
      }

      const detailSheets: BillingSheet[] = (data.details ?? []).map(
        (d: { institution: string; rows: ReportRow[]; cols: ColumnDef[] }) => ({
          name: d.institution.slice(0, 31),
          rows: d.rows,
          cols: d.cols,
        }),
      )

      const sheets: BillingSheet[] = [summarySheet, ...detailSheets]
      const filename = `billing_report_${filters.dateFrom ?? 'export'}`
      await downloadBillingExcel(sheets, filename)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function toggleExtra(key: string) {
    setActiveExtra(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function resetFilters() {
    setFilters({ institution: '', dateFrom: '2026-04-01', dateTo: '2026-04-30' })
    setGroomingSegment('all')
    setShowCustomDates(false)
    setInstitutionDates({})
    setExcludedInstitutions(new Set())
    setSummaryRows([])
    setDetailRows(null)
    setHasData(false)
    setEmptyWarn(false)
    setRanInst('')
    setError('')
    _billingCache = null
    clearLastPaymentCache()
    setLastPaymentDates({})
    fetchLastPaymentDates()
  }

  return (
    <div className="flex h-screen flex-col">

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-12">

      {/* Topbar */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Billing Report</h1>
          <p className="mt-0.5 text-xs text-gray-400">
            Commission-based billing summary with per-institution recovery breakdown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetFilters}
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-semibold text-gray-400 transition hover:bg-gray-100"
          >
            <FiRotateCcw className="h-3 w-3" /> Reset
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
      <div className="flex-shrink-0 border-b border-gray-200 bg-white px-7 py-4">
        <div className="flex items-end gap-6">

          {/* Institution */}
          <div className="flex w-56 flex-col">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Institution</label>
            <select
              value={filters.institution ?? ''}
              onChange={e => setFilters(f => ({ ...f, institution: e.target.value }))}
              className={inputCls}
            >
              <option value="">All Institutions</option>
              {ALL_INSTITUTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="h-9 w-px self-end bg-gray-200" />

          {/* Date range */}
          <div className="flex flex-col">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Date Range</label>
            <div className="flex items-end gap-3">
              <div className="flex flex-col">
                <span className="mb-1 text-[10px] text-gray-400">From</span>
                <input
                  type="date"
                  value={filters.dateFrom ?? ''}
                  onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
                  className="w-40 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10 cursor-pointer"
                />
              </div>
              <span className="mb-2 select-none text-sm text-gray-300">→</span>
              <div className="flex flex-col">
                <span className="mb-1 text-[10px] text-gray-400">To</span>
                <input
                  type="date"
                  value={filters.dateTo ?? ''}
                  onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
                  className="w-40 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* GROOMING MFI segment filter */}
          {isGroomingMfi && (
            <>
              <div className="h-9 w-px self-end bg-gray-200" />
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Portfolio Segment
                </label>
                <div className="flex rounded-md border border-gray-200 bg-gray-50 p-0.5">
                  {([
                    { value: 'all',  label: 'All' },
                    { value: '90+',  label: '90+' },
                    { value: '360+', label: '360+ / Written Off' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setGroomingSegment(opt.value)}
                      className={`rounded px-3 py-1 text-[12px] font-semibold transition ${
                        groomingSegment === opt.value
                          ? 'bg-[#2E7D32] text-white'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Custom dates toggle */}
          {isAllMode && (
            <>
              <div className="h-9 w-px self-end bg-gray-200" />
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Per-institution dates
                </label>
                <button
                  onClick={toggleCustomDates}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] font-semibold transition ${
                    showCustomDates
                      ? 'border-[#2E7D32] bg-[#2E7D32]/10 text-[#2E7D32]'
                      : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:bg-gray-100'
                  }`}
                >
                  <FiCalendar className="h-3.5 w-3.5" />
                  {showCustomDates ? 'Custom dates on' : 'Customize'}
                </button>
              </div>
            </>
          )}

        </div>
      </div>

      {/* Per-institution date overrides panel */}
      {isAllMode && showCustomDates && (
        <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50/60 px-7 pt-3 pb-2">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Custom date range per institution
            </p>
            {loadingLastDates && (
              <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-400" />
                Fetching last payment dates…
              </span>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {ALL_INSTITUTIONS.map(inst => {
                const excluded = excludedInstitutions.has(inst)
                return (
                  <div
                    key={inst}
                    className={`rounded-md border bg-white p-2.5 transition-opacity ${
                      excluded ? 'border-gray-100 opacity-40' : 'border-gray-200'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-1">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-bold text-gray-700">{inst}</p>
                        {lastPaymentDates[inst] ? (
                          <p className="text-[10px] text-gray-400">Last payment: {fmtLastPayment(lastPaymentDates[inst])}</p>
                        ) : loadingLastDates ? (
                          <p className="text-[10px] text-gray-300 animate-pulse">Loading…</p>
                        ) : null}
                      </div>
                      <button
                        onClick={() => toggleExcluded(inst)}
                        title={excluded ? 'Re-include institution' : 'Exclude institution'}
                        className="shrink-0 rounded p-0.5 text-gray-300 transition hover:bg-gray-100 hover:text-gray-500"
                      >
                        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="2" y1="2" x2="10" y2="10" />
                          <line x1="10" y1="2" x2="2" y2="10" />
                        </svg>
                      </button>
                    </div>
                    <div className={`flex items-center gap-1.5 ${excluded ? 'pointer-events-none' : ''}`}>
                      <input
                        type="date"
                        value={institutionDates[inst]?.dateFrom ?? filters.dateFrom ?? ''}
                        onChange={e => setInstDate(inst, 'dateFrom', e.target.value)}
                        className="min-w-0 flex-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-900 outline-none focus:border-[#2E7D32]"
                      />
                      <span className="shrink-0 text-[10px] text-gray-300">→</span>
                      <input
                        type="date"
                        value={institutionDates[inst]?.dateTo ?? filters.dateTo ?? ''}
                        onChange={e => setInstDate(inst, 'dateTo', e.target.value)}
                        className="min-w-0 flex-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-900 outline-none focus:border-[#2E7D32]"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <p className="mt-2 text-[10px] text-gray-400">
            Institutions with no deposits in their specified range will be excluded from the report.
          </p>
        </div>
      )}

      {/* Stats dashboard */}
      {hasData && !emptyWarn && <BillingStatsBar rows={summaryRows} currency={currency} fxRate={fxRate} />}

      {/* Currency toggle + FX info bar */}
      {hasData && !emptyWarn && (
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

      {/* Extra column toggles */}
      {BILLING_SUMMARY_EXTRA_COLUMNS.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 bg-white px-7 py-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">
            Show
          </span>
          {BILLING_SUMMARY_EXTRA_COLUMNS.map(col => (
            <button
              key={col.key}
              onClick={() => toggleExtra(col.key)}
              className={`rounded-full border px-3 py-0.5 text-[11px] font-semibold transition ${
                activeExtra.has(col.key)
                  ? 'border-[#2E7D32] bg-[#2E7D32]/10 text-[#2E7D32]'
                  : 'border-gray-200 bg-white text-gray-400 hover:border-gray-300'
              }`}
            >
              {col.label}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}

      {/* No-data warning banner */}
      {hasData && emptyWarn && (
        <div className="flex-shrink-0 bg-amber-50 px-7 py-2.5 text-xs font-semibold text-amber-700">
          No recoveries recorded for this period
          {isSingleInst ? ` for ${filters.institution}` : ''}. If you download, the file will contain
          only headers with no data rows.
        </div>
      )}

      {/* Excel hint — uses ranInst (what was actually run), not live filter value */}
      {hasData && isSingleInst && !emptyWarn && (
        <div className="flex-shrink-0 bg-blue-50 px-7 py-2 text-xs text-blue-600">
          Excel download will include a <strong>Summary</strong> sheet and a <strong>{ranInst} Recovery</strong> detail sheet.
        </div>
      )}
      {hasData && !isSingleInst && !emptyWarn && (
        <div className="flex-shrink-0 bg-blue-50 px-7 py-2 text-xs text-blue-600">
          Excel download will include a <strong>Summary</strong> sheet plus one detail sheet per institution that has recovery data.
        </div>
      )}

      {/* Summary table */}
        {hasData ? (
          <div className="overflow-x-auto">
            <ReportTable
              rows={displaySummaryRows}
              columns={visibleSummaryCols}
              getCurrencySymbol={() => currency === 'KES' ? 'KSh' : '₦'}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200 text-2xl">
              <FiFileText className="h-6 w-6" />
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
              <strong className="text-gray-900">{summaryRows.length}</strong> summary rows
              {isSingleInst && detailRows != null && (
                <> &nbsp;·&nbsp; <strong className="text-gray-900">{detailRows.length}</strong> detail rows</>
              )}
              {execMs != null && (
                <> &nbsp;·&nbsp; <span className="font-mono">{execMs}ms</span></>
              )}
            </>
          ) : '—'}
        </p>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">
            Export as
          </span>
          <button
            onClick={handleExport}
            disabled={!hasData || exporting}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
            ) : <FiDownload className="h-3 w-3" />}
            EXCEL
          </button>
        </div>
      </div>
    </div>
  )
}
