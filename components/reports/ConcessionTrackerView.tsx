'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { getAuth }                         from 'firebase/auth'
import { FiPlay, FiRotateCcw, FiFileText, FiDownload } from 'react-icons/fi'
import { downloadExcel } from '@/lib/reports/export'
import { CONCESSION_INSTITUTIONS, CONCESSION_ACTIVE } from '@/lib/reports/concession.queries'

// ─── Month / year constants ───────────────────────────────────────────────────
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const CONCESSION_START_YEAR = 2026
const YEAR_OPTIONS = Array.from(
  { length: new Date().getFullYear() - CONCESSION_START_YEAR + 1 },
  (_, i) => String(new Date().getFullYear() - i),
)
const currentMonth = new Date().getMonth() + 1

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Row = Record<string, string | number | null>
type Status =
  | 'paid_original'
  | 'paid_offer_1'
  | 'paid_offer_2'
  | 'paid_offer_3'
  | 'partial_concession'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function n(v: string | number | null | undefined): number {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0
}
function fmt(v: number, kes = false): string {
  if (!isFinite(v)) return '—'
  return kes
    ? 'KSh ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '₦'    + v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pct(num: number, den: number): string {
  if (!den) return '—'
  return (num / den * 100).toFixed(1) + '%'
}

// ─── Institution tolerances ───────────────────────────────────────────────────
const INSTITUTION_TOLERANCES: Record<string, { origTol: number; offerTol: number }> = {
  'KUDA':          { origTol: 10000, offerTol: 1000 },
  'CREDIT DIRECT': { origTol: 100,   offerTol: 100  },
  'PEZESHA':       { origTol: 50,    offerTol: 50   },
}

const KES_INSTITUTIONS = new Set(['PEZESHA', 'NUMIDA'])

// ─── Status classification ────────────────────────────────────────────────────
function rowStatus(row: Row, institution: string): Status {
  const { offerTol } = INSTITUTION_TOLERANCES[institution] ?? { origTol: 1000, offerTol: 1000 }
  const paid = n(row.amount_paid)
  const due  = n(row.amount_due)
  const d1   = n(row.discount1)
  const d2   = n(row.discount2)
  const d3   = n(row.discount3)

  const origTol = institution === 'CREDIT DIRECT'
    ? (due > 10000 ? 500 : 100)
    : (INSTITUTION_TOLERANCES[institution]?.origTol ?? 1000)

  if (paid >= due - origTol)                              return 'paid_original'
  if (paid >= d1 - offerTol && paid < due - origTol)     return 'paid_offer_1'
  if (paid >= d2 - offerTol && paid < d1 - offerTol)     return 'paid_offer_2'
  if (paid >= d3 - offerTol && paid < d2 - offerTol)     return 'paid_offer_3'
  return 'partial_concession'
}

const STATUS_META: Record<Status, { label: string; color: string; bg: string; dot: string }> = {
  paid_original:      { label: 'Paid Original',         color: '#1D4ED8', bg: '#EFF6FF', dot: '#3B82F6' },
  paid_offer_1:       { label: 'Paid at Offer 1',       color: '#15803D', bg: '#F0FDF4', dot: '#22C55E' },
  paid_offer_2:       { label: 'Paid at Offer 2',       color: '#0E7490', bg: '#ECFEFF', dot: '#06B6D4' },
  paid_offer_3:       { label: 'Paid at Offer 3',       color: '#0F766E', bg: '#F0FDFA', dot: '#14B8A6' },
  partial_concession: { label: 'Partial — Concession',  color: '#92400E', bg: '#FFFBEB', dot: '#F59E0B' },
}

const ALL_STATUSES: Status[] = [
  'paid_original',
  'paid_offer_1', 'paid_offer_2', 'paid_offer_3',
  'partial_concession',
]

// ─── Donut Chart ──────────────────────────────────────────────────────────────
function DonutChart({ counts, total }: { counts: Record<Status, number>; total: number }) {
  if (!total) return <div className="flex h-48 items-center justify-center text-xs text-gray-300">No data</div>

  const R = 58, CX = 80, CY = 80
  const circ = 2 * Math.PI * R

  const paidConcession = counts.paid_offer_1 + counts.paid_offer_2 + counts.paid_offer_3

  const segments: { key: string; label: string; count: number; dot: string }[] = [
    { key: 'paid_concession',    label: 'Paid Concession',     count: paidConcession,               dot: '#22C55E'                          },
    { key: 'paid_original',      label: 'Paid Original',       count: counts.paid_original,          dot: STATUS_META.paid_original.dot     },
    { key: 'partial_concession', label: 'Partial — Concession',count: counts.partial_concession,     dot: STATUS_META.partial_concession.dot},
  ]

  let offset = 0
  const arcs = segments.map(seg => {
    const frac   = seg.count / total
    const dash   = frac * circ
    const gap    = circ - dash
    const rotate = offset * 360 - 90
    offset += frac
    return { ...seg, frac, dash, gap, rotate }
  }).filter(a => a.frac > 0)

  return (
    <div className="flex items-start gap-5">
      <svg width={160} height={160} viewBox="0 0 160 160" className="flex-shrink-0">
        {arcs.map(arc => (
          <circle
            key={arc.key}
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke={arc.dot}
            strokeWidth={24}
            strokeDasharray={`${arc.dash.toFixed(2)} ${arc.gap.toFixed(2)}`}
            strokeDashoffset={0}
            transform={`rotate(${arc.rotate} ${CX} ${CY})`}
          />
        ))}
        <text x={CX} y={CY - 6} textAnchor="middle" fontSize="18" fontWeight="700" fill="#111827">{total}</text>
        <text x={CX} y={CY + 11} textAnchor="middle" fontSize="9" fill="#9CA3AF">TOTAL</text>
      </svg>

      <div className="flex flex-col gap-1.5 pt-1">
        {segments.map(seg => (
          <div key={seg.key} className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: seg.dot }} />
            <div>
              <p className="text-[11px] font-semibold text-gray-700">{seg.label}</p>
              <p className="text-[10px] text-gray-400">{seg.count} · {pct(seg.count, total)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Offer Tier Cards ─────────────────────────────────────────────────────────
function OfferTierCards({
  counts, amounts, total, isKes,
}: {
  counts:  Record<Status, number>
  amounts: Record<Status, number>
  total:   number
  isKes:   boolean
}) {
  const tiers: { status: Status; offer: string; sub: string }[] = [
    { status: 'paid_offer_1', offer: 'Paid at Offer 1', sub: 'First concession tier accepted' },
    { status: 'paid_offer_2', offer: 'Paid at Offer 2', sub: 'Second concession tier accepted' },
    { status: 'paid_offer_3', offer: 'Paid at Offer 3', sub: 'Deepest concession tier accepted' },
  ]

  return (
    <div className="flex flex-col gap-3">
      {tiers.map(({ status, offer, sub }) => {
        const meta = STATUS_META[status]
        return (
          <div
            key={status}
            className="flex items-center justify-between rounded-lg border px-4 py-3"
            style={{ borderColor: meta.dot + '40', background: meta.bg }}
          >
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 flex-shrink-0 rounded-full" style={{ background: meta.dot }} />
              <div>
                <p className="text-[12px] font-bold" style={{ color: meta.color }}>{offer}</p>
                <p className="text-[10px] text-gray-400">{sub}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[13px] font-bold text-gray-900">{fmt(amounts[status], isKes)}</p>
              <p className="text-[10px] text-gray-400">
                {counts[status]} customer{counts[status] !== 1 ? 's' : ''} · {pct(counts[status], total)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`flex flex-col gap-0.5 rounded-lg border px-4 py-3 ${accent ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</span>
      <span className={`text-lg font-bold tracking-tight ${accent ? 'text-green-700' : 'text-gray-900'}`}>{value}</span>
      {sub && <span className="text-[10px] text-gray-400">{sub}</span>}
    </div>
  )
}

// ── Module-level cache — survives navigation within the session ───────────────
interface ConcessionSnapshot {
  institution: string
  year:        string
  month:       number
  dateFrom:    string
  dateTo:      string
  rows:        Row[]
  hasData:     boolean
  execMs:      number | null
  activeExtra: string[]
}
let _concessionCache: ConcessionSnapshot | null = null

// ─── Main component ───────────────────────────────────────────────────────────
const inputCls = `rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px]
  text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10
  cursor-pointer font-[var(--font-sans)]`

export default function ConcessionTrackerView() {
  const c = _concessionCache

  const [institution, setInstitution] = useState(c?.institution ?? 'KUDA')
  const [year,        setYear]        = useState(c?.year        ?? '2026')
  const [month,       setMonth]       = useState(c?.month       ?? currentMonth)
  const [dateFrom,    setDateFrom]    = useState(c?.dateFrom    ?? `2026-${String(currentMonth).padStart(2,'0')}-01`)
  const [dateTo,      setDateTo]      = useState(c?.dateTo      ?? lastDayOfMonth(2026, currentMonth))

  const isKudaMode = institution === 'KUDA'
  const isKes      = KES_INSTITUTIONS.has(institution)
  const minMonth   = year === '2026' ? 2 : 1

  function handleYearChange(newYear: string) {
    setYear(newYear)
    if (newYear === '2026') setMonth(prev => Math.max(prev, 2))
  }

  useEffect(() => {
    if (!isKudaMode) return
    const y = parseInt(year)
    setDateFrom(`${year}-${String(month).padStart(2, '0')}-01`)
    setDateTo(lastDayOfMonth(y, month))
  }, [isKudaMode, year, month])
  const [rows,        setRows]        = useState<Row[]>(c?.rows        ?? [])
  const [hasData,     setHasData]     = useState(c?.hasData      ?? false)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [execMs,      setExecMs]      = useState<number | null>(c?.execMs ?? null)
  const [exporting,   setExporting]   = useState(false)
  const [activeExtra, setActiveExtra] = useState<Set<string>>(new Set(c?.activeExtra ?? []))

  const EXTRA_COLS = [
    { key: 'ptp_date', label: 'PTP Date' },
    { key: 'agent',    label: 'Agent'    },
  ] as const

  function toggleExtra(key: string) {
    setActiveExtra(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      if (_concessionCache) _concessionCache.activeExtra = [...next]
      return next
    })
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!rows.length) return null

    const mapped = rows.map(r => ({ row: r, status: rowStatus(r, institution) }))

    const byStatus = (s: Status) => mapped.filter(x => x.status === s)

    const counts  = Object.fromEntries(ALL_STATUSES.map(s => [s, byStatus(s).length])) as Record<Status, number>
    const amounts = Object.fromEntries(
      ALL_STATUSES.map(s => [s, byStatus(s).reduce((acc, x) => acc + n(x.row.amount_paid), 0)])
    ) as Record<Status, number>

    const totalPaid    = rows.reduce((s, r) => s + n(r.amount_paid), 0)
    const totalOffered = rows.reduce((s, r) => s + n(r.discount3), 0) // deepest offer as reference

    // Discount granted = what was written off for each concession payer
    const discountGranted = (['paid_offer_1', 'paid_offer_2', 'paid_offer_3'] as const).reduce((sum, s) => {
      const discountKey = s === 'paid_offer_1' ? 'discount1' : s === 'paid_offer_2' ? 'discount2' : 'discount3'
      return sum + byStatus(s).reduce((acc, x) => acc + (n(x.row.amount_due) - n(x.row[discountKey])), 0)
    }, 0)

    const concessionPayers   = counts.paid_offer_1 + counts.paid_offer_2 + counts.paid_offer_3
    const conversionRate     = rows.length ? (concessionPayers / rows.length) * 100 : 0
    const avgRecoveryRate    = rows.length
      ? rows.reduce((s, r) => s + (n(r.amount_due) ? n(r.amount_paid) / n(r.amount_due) : 0), 0) / rows.length * 100
      : 0
    const concessionEff = totalOffered ? (totalPaid / totalOffered) * 100 : 0

    return {
      total: rows.length,
      counts, amounts,
      totalPaid, totalOffered,
      discountGranted, conversionRate, avgRecoveryRate, concessionEff,
    }
  }, [rows, institution])

  // ── Run ────────────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const res = await fetch('/api/reports/concession/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ institution, dateFrom, dateTo }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data = await res.json()
      const newRows = data.rows ?? []
      setRows(newRows)
      setExecMs(data.executionMs)
      setHasData(true)
      _concessionCache = {
        institution, year, month, dateFrom, dateTo,
        rows: newRows, hasData: true, execMs: data.executionMs,
        activeExtra: [...activeExtra],
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [institution, dateFrom, dateTo])

  async function handleExport() {
    if (!hasData || !rows.length) return
    setExporting(true)
    try {
      const exportRows = rows.map(r => ({
        ...r,
        status:      STATUS_META[rowStatus(r, institution)].label,
        recovery_pct: n(r.amount_due) > 0
          ? ((n(r.amount_paid) / n(r.amount_due)) * 100).toFixed(1) + '%'
          : '—',
      }))
      const cols = [
        { key: 'account_number',      label: 'Account No.',       type: 'mono'     as const },
        { key: 'account_holder_name', label: 'Name',              type: 'text'     as const },
        { key: 'mobile_phone',        label: 'Phone',             type: 'text'     as const },
        { key: 'customer_email',      label: 'Email',             type: 'text'     as const },
        { key: 'amount_due',          label: 'Amount Due',        type: 'currency' as const },
        { key: 'discount1',           label: 'Offer 1',           type: 'currency' as const },
        { key: 'discount2',           label: 'Offer 2',           type: 'currency' as const },
        { key: 'discount3',           label: 'Offer 3',           type: 'currency' as const },
        { key: 'amount_paid',         label: 'Amount Paid',       type: 'currency' as const },
        { key: 'recovery_pct',        label: 'Recovery %',        type: 'text'     as const },
        { key: 'status',              label: 'Status',            type: 'text'     as const },
        { key: 'ptp_date',            label: 'PTP Date',          type: 'date'     as const },
        { key: 'contacted_date',      label: 'Contacted Date',    type: 'date'     as const },
        { key: 'agent',               label: 'Agent',             type: 'text'     as const },
      ]
      const stamp = new Date().toISOString().slice(0, 10)
      await downloadExcel(exportRows, cols, `concession_tracker_${institution}_${stamp}`, 'Concession Tracker')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  function reset() {
    setRows([])
    setHasData(false)
    setError('')
    setExecMs(null)
    setInstitution('KUDA')
    setYear('2026')
    setMonth(currentMonth)
    _concessionCache = null
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-14">

        {/* Topbar */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
          <div>
            <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Concession Tracker</h1>
            <p className="mt-0.5 text-xs text-gray-400">
              Track concession offers, conversions, and recovery outcomes per institution
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-semibold text-gray-400 transition hover:bg-gray-100"
            >
              <FiRotateCcw className="h-3 w-3" /> Reset
            </button>
            <button
              onClick={runReport}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md bg-[#2E7D32] px-4 py-1.5 text-xs font-bold text-white transition hover:bg-[#1B5E20] disabled:opacity-60"
            >
              {loading
                ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                : <FiPlay className="h-3 w-3" />}
              Run Report
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex-shrink-0 border-b border-gray-200 bg-white px-7 py-4">
          <div className="flex items-end gap-6">
            <div className="flex flex-col">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Institution</label>
              <select
                value={institution}
                onChange={e => setInstitution(e.target.value)}
                className={`w-52 ${inputCls}`}
              >
                {CONCESSION_INSTITUTIONS.map(inst => (
                  <option key={inst} value={inst} disabled={!CONCESSION_ACTIVE.has(inst as any)}>
                    {inst}{!CONCESSION_ACTIVE.has(inst as any) ? ' (coming soon)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="h-9 w-px self-end bg-gray-200" />

            {isKudaMode ? (
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Month</label>
                <div className="flex items-end gap-3">
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">Year</span>
                    <select value={year} onChange={e => handleYearChange(e.target.value)} className={`w-24 ${inputCls}`}>
                      {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">Month</span>
                    <select value={month} onChange={e => setMonth(Number(e.target.value))} className={`w-28 ${inputCls}`}>
                      {MONTH_LABELS
                        .map((label, i) => ({ label, num: i + 1 }))
                        .filter(m => m.num >= minMonth && (year !== String(new Date().getFullYear()) || m.num <= currentMonth))
                        .map(m => <option key={m.label} value={m.num}>{m.label}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Date Range</label>
                <div className="flex items-end gap-3">
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">From</span>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                      className="w-40 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer" />
                  </div>
                  <span className="mb-2 select-none text-sm text-gray-300">→</span>
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">To</span>
                    <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                      className="w-40 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">{error}</div>
        )}

        {hasData && stats ? (
          <>
            {/* KPI Row 1 — Counts */}
            <div className="grid grid-cols-4 gap-3 border-b border-gray-100 px-7 py-4">
              <KpiCard label="Total on List"           value={String(stats.total)}
                sub="customers with payments & concession offer" />
              <KpiCard label="Paid Concession"
                value={String(stats.counts.paid_offer_1 + stats.counts.paid_offer_2 + stats.counts.paid_offer_3)}
                sub={`${pct(stats.counts.paid_offer_1 + stats.counts.paid_offer_2 + stats.counts.paid_offer_3, stats.total)} · any offer tier`}
                accent />
              <KpiCard label="Paid Original Amount"    value={String(stats.counts.paid_original)}
                sub={`${pct(stats.counts.paid_original, stats.total)} · paid full balance`} />
              <KpiCard label="Partial — Concession"    value={String(stats.counts.partial_concession)}
                sub={`${pct(stats.counts.partial_concession, stats.total)} · below cheapest offer`} />
            </div>

            {/* KPI Row 2 — Money */}
            <div className="grid grid-cols-5 gap-3 border-b border-gray-100 px-7 py-4">
              <KpiCard label="Total Recovered" value={fmt(stats.totalPaid, isKes)}
                sub="payments from customers offered concession" accent />
              <KpiCard label="Discount Granted"        value={fmt(stats.discountGranted, isKes)}
                sub="due minus offer paid, concession payers only" />
              <KpiCard label="Concession Conversion Rate"   value={stats.conversionRate.toFixed(1) + '%'}
                sub="paid concession customers / total paid customers" />
              <KpiCard label="Avg Recovery Rate"       value={stats.avgRecoveryRate.toFixed(1) + '%'}
                sub="avg amount_paid / amount_due" />
              <KpiCard label="Concession Efficiency"   value={stats.concessionEff.toFixed(1) + '%'}
                sub="total paid / total offer-3 value" />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-2 gap-0 border-b border-gray-100">
              <div className="border-r border-gray-100 px-7 py-5">
                <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Outcome Breakdown</p>
                <DonutChart counts={stats.counts} total={stats.total} />
              </div>
              <div className="px-7 py-5">
                <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Concession Tier Breakdown</p>
                <OfferTierCards counts={stats.counts} amounts={stats.amounts} total={stats.total} isKes={isKes} />
              </div>
            </div>

            {/* Table — optional column toggles */}
            <div className="flex items-center gap-2 border-b border-gray-100 bg-white px-7 py-2.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mr-1">Show</span>
              {EXTRA_COLS.map(col => (
                <button
                  key={col.key}
                  onClick={() => toggleExtra(col.key)}
                  className={`rounded-full border px-3 py-0.5 text-[11px] font-semibold transition
                    ${activeExtra.has(col.key)
                      ? 'border-[#2E7D32] bg-[#2E7D32] text-white'
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}
                >
                  {col.label}
                </button>
              ))}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    {['Account No.', 'Name', 'Phone', 'Amount Due', 'Offer 1', 'Offer 2', 'Offer 3', 'Amount Paid', 'Recovery %'].map(h => (
                      <th key={h} className={`whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400${h === 'Name' ? ' w-[220px]' : ''}`}>
                        {h}
                      </th>
                    ))}
                    <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</th>
                    {activeExtra.has('ptp_date') && (
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">PTP Date</th>
                    )}
                    {activeExtra.has('agent') && (
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">Agent</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const status   = rowStatus(row, institution)
                    const meta     = STATUS_META[status]
                    const due      = n(row.amount_due)
                    const paid     = n(row.amount_paid)
                    const recovPct = due > 0 ? ((paid / due) * 100).toFixed(1) + '%' : '—'
                    return (
                      <tr key={i} className="whitespace-nowrap border-b border-gray-100 hover:bg-gray-50/60">
                        <td className="px-4 py-2 font-mono text-[11px] text-gray-500">{row.account_number ?? '—'}</td>
                        <td className="w-[220px] truncate px-4 py-2 font-medium text-gray-800">
                          {String(row.account_holder_name ?? '').trim() || '—'}
                        </td>
                        <td className="px-4 py-2 text-gray-500">{row.mobile_phone ?? '—'}</td>
                        <td className="px-4 py-2 text-right font-sans text-gray-700">{fmt(due, isKes)}</td>
                        <td className="px-4 py-2 text-right font-sans text-[11px] text-gray-400">{fmt(n(row.discount1), isKes)}</td>
                        <td className="px-4 py-2 text-right font-sans text-[11px] text-gray-400">{fmt(n(row.discount2), isKes)}</td>
                        <td className="px-4 py-2 text-right font-sans text-[11px] text-gray-400">{fmt(n(row.discount3), isKes)}</td>
                        <td className="px-4 py-2 text-right font-sans font-semibold text-green-700">{fmt(paid, isKes)}</td>
                        <td className="px-4 py-2 text-right text-gray-500">{recovPct}</td>
                        <td className="px-4 py-2">
                          <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold"
                            style={{ color: meta.color, background: meta.bg }}>
                            {meta.label}
                          </span>
                        </td>
                        {activeExtra.has('ptp_date') && (
                          <td className="px-4 py-2 font-mono text-[11px] text-gray-400">{row.ptp_date ?? '—'}</td>
                        )}
                        {activeExtra.has('agent') && (
                          <td className="px-4 py-2 text-gray-500">{row.agent ?? '—'}</td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          !loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200">
                <FiFileText className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-gray-500">No data loaded</p>
              <p className="text-xs">Select an institution and date range, then click Run Report</p>
            </div>
          )
        )}

        {loading && (
          <div className="flex items-center justify-center gap-3 py-24 text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-[#2E7D32]" />
            <span className="text-sm">Running query…</span>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-[260px] right-0 z-10 flex items-center justify-between border-t border-gray-200 bg-white px-7 py-2.5">
        <p className="text-xs text-gray-400">
          {hasData && stats ? (
            <>
              <strong className="text-gray-900">{rows.length}</strong> customers
              {execMs != null && <> &nbsp;·&nbsp; <span className="font-mono">{execMs}ms</span></>}
              &nbsp;·&nbsp;
              <span className="text-green-700 font-semibold">{fmt(stats.totalPaid, isKes)}</span> total recovered
              &nbsp;·&nbsp;
              <span className="text-amber-700">{fmt(stats.discountGranted, isKes)}</span> discount granted
            </>
          ) : '—'}
        </p>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">Export as</span>
          <button
            onClick={handleExport}
            disabled={!hasData || exporting}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting
              ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
              : <FiDownload className="h-3 w-3" />}
            EXCEL
          </button>
        </div>
      </div>
    </div>
  )
}
