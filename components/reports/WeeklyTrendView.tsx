'use client'

import { useState, useCallback, useMemo } from 'react'
import { FiDownload, FiPlay, FiRotateCcw, FiTrendingUp } from 'react-icons/fi'
import { getAuth }               from 'firebase/auth'
import { ALL_INSTITUTIONS }      from '@/lib/reports/reports.config'
import type { ReportRow }        from '@/types'
import { downloadExcel }         from '@/lib/reports/export'
import { trendCache as _sharedCache, setTrendCache } from '@/lib/reports/trend-cache'

// ── Month definitions ────────────────────────────────────────────────────────
const MONTHS = [
  { key: 'jan', label: 'Jan', num: 1  },
  { key: 'feb', label: 'Feb', num: 2  },
  { key: 'mar', label: 'Mar', num: 3  },
  { key: 'apr', label: 'Apr', num: 4  },
  { key: 'may', label: 'May', num: 5  },
  { key: 'jun', label: 'Jun', num: 6  },
  { key: 'jul', label: 'Jul', num: 7  },
  { key: 'aug', label: 'Aug', num: 8  },
  { key: 'sep', label: 'Sep', num: 9  },
  { key: 'oct', label: 'Oct', num: 10 },
  { key: 'nov', label: 'Nov', num: 11 },
  { key: 'dec', label: 'Dec', num: 12 },
] as const

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const START_YEAR   = 2025
const YEAR_OPTIONS = Array.from(
  { length: new Date().getFullYear() - START_YEAR + 1 },
  (_, i) => String(new Date().getFullYear() - i),
)
const currentMonth = new Date().getMonth() + 1

// ── Module-level cache (shared via lib/reports/trend-cache.ts) ───────────────
// _sharedCache alias used so local read pattern matches original style.

const KES_INSTITUTIONS = new Set(['NUMIDA', 'PEZESHA'])

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseMoney(val: string | number | null | undefined): number {
  if (val == null || val === '') return 0
  return parseFloat(String(val).replace(/,/g, '')) || 0
}

function fmtAmount(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function convertAmount(amount: number, isKesInstitution: boolean, currency: 'NGN' | 'KES', fxRate: number): number {
  if (isKesInstitution && currency === 'NGN') return amount * fxRate
  if (!isKesInstitution && currency === 'KES') return amount / fxRate
  return amount
}

function TrendIcon({ current, prev }: { current: number; prev: number | null }) {
  if (prev === null || prev === 0) return null
  if (current > prev)
    return <span className="ml-1 text-[9px] font-bold text-[#2E7D32]">▲</span>
  if (current < prev)
    return <span className="ml-1 text-[9px] font-bold text-red-500">▼</span>
  return <span className="ml-1 text-[9px] text-gray-300">—</span>
}

const inputCls = `
  rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px]
  text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2
  focus:ring-[#2E7D32]/10 w-full cursor-pointer
`
const labelCls = 'text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5 block'

// ── Component ─────────────────────────────────────────────────────────────────
export default function WeeklyTrendView() {
  const c = _sharedCache

  const [year,        setYear]        = useState(c?.year        ?? String(new Date().getFullYear()))
  const [monthFrom,   setMonthFrom]   = useState(c?.monthFrom   ?? (c?.year === '2025' ? 5 : 1))
  const [monthTo,     setMonthTo]     = useState(c?.monthTo     ?? currentMonth)

  // May 2025 is the earliest possible month
  const minMonth = year === '2025' ? 5 : 1

  function handleYearChange(newYear: string) {
    setYear(newYear)
    if (newYear === '2025') {
      setMonthFrom((prev: number) => Math.max(prev, 5))
      setMonthTo((prev: number) => Math.max(prev, 5))
    }
    setHasData(false)
    setRows([])
    setExecMs(null)
    setTrendCache(null)
  }
  const [institution, setInstitution] = useState(c?.institution ?? '')
  const [rows,        setRows]        = useState<ReportRow[]>(c?.rows ?? [])
  const [hasData,     setHasData]     = useState(!!c)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [execMs,      setExecMs]      = useState<number | null>(c?.execMs ?? null)
  const [fxRate,      setFxRate]      = useState<number>(c?.fxRate ?? 10.5)
  const [currency,    setCurrency]    = useState<'NGN' | 'KES'>(
    KES_INSTITUTIONS.has(c?.institution ?? '') ? 'KES' : 'NGN',
  )

  const visibleMonths    = MONTHS.filter(m => m.num >= monthFrom && m.num <= monthTo)
  const isKesInstitution = KES_INSTITUTIONS.has(institution)

  const displayRows = useMemo(() =>
    rows.map(row => {
      const converted: Record<string, unknown> = { ...row }
      for (const m of MONTHS) {
        converted[m.key] = convertAmount(parseMoney(row[m.key]), isKesInstitution, currency, fxRate)
      }
      return converted as typeof row
    }),
    [rows, currency, fxRate, isKesInstitution],
  )

  // ── Totals row ───────────────────────────────────────────────────────────────
  const totals = useMemo(() =>
    visibleMonths.reduce<Record<string, number>>((acc, m) => {
      acc[m.key] = displayRows.reduce((s, r) => s + parseMoney(r[m.key]), 0)
      return acc
    }, {}),
    [displayRows, visibleMonths],
  )

  // ── Run ──────────────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const res   = await fetch('/api/reports/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ bqKey: 'bq_weekly_trend', filters: { institution, year } }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data = await res.json()
      const rate = data.fxRate ?? 10.5
      setRows(data.rows)
      setExecMs(data.executionMs)
      setFxRate(rate)
      setCurrency(KES_INSTITUTIONS.has(institution) ? 'KES' : 'NGN')
      setHasData(true)
      setTrendCache({ rows: data.rows, year, monthFrom, monthTo, institution, execMs: data.executionMs, fxRate: rate })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [institution, year, monthFrom, monthTo])

  // ── Reset ────────────────────────────────────────────────────────────────────
  function reset() {
    const resetYear = String(new Date().getFullYear())
    setYear(resetYear)
    setMonthFrom(resetYear === '2025' ? 5 : 1)
    setMonthTo(currentMonth)
    setInstitution('')
    setRows([])
    setHasData(false)
    setError('')
    setExecMs(null)
    setTrendCache(null)
  }

  // ── Export ───────────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!hasData) return
    const cols = [
      { key: 'week', label: 'Week', type: 'text' as const },
      ...visibleMonths.map(m => ({ key: m.key, label: m.label, type: 'currency' as const })),
    ]
    const exportRows = [
      ...rows,
      { week: 'TOTAL', ...Object.fromEntries(visibleMonths.map(m => [m.key, totals[m.key]])) },
    ]
    await downloadExcel(exportRows, cols, `weekly_trend_${year}`, 'Weekly Trend Report')
  }

  return (
    <div className="flex h-screen flex-col">

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-12">

      {/* Topbar */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Weekly Trend Report</h1>
          <p className="mt-0.5 text-xs text-gray-400">Week-by-week recovery totals across months</p>
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

          <div className="flex w-56 flex-col">
            <label className={labelCls}>Institution</label>
            <select value={institution} onChange={e => setInstitution(e.target.value)} className={inputCls}>
              <option value="">All Institutions</option>
              {ALL_INSTITUTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="h-9 w-px self-end bg-gray-200" />

          <div className="flex w-28 flex-col">
            <label className={labelCls}>Year</label>
            <select value={year} onChange={e => handleYearChange(e.target.value)} className={inputCls}>
              {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div className="h-9 w-px self-end bg-gray-200" />

          <div className="flex flex-col">
            <label className={labelCls}>Month Range</label>
            <div className="flex items-end gap-3">
              <div className="flex flex-col">
                <span className="mb-1 text-[10px] text-gray-400">From</span>
                <select
                  value={monthFrom}
                  onChange={e => setMonthFrom(Number(e.target.value))}
                  className="w-28 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer"
                >
                  {MONTH_LABELS.filter((_, i) => i + 1 >= minMonth).map(m => (
                    <option key={m} value={MONTH_LABELS.indexOf(m) + 1}>{m}</option>
                  ))}
                </select>
              </div>
              <span className="mb-2 select-none text-sm text-gray-300">→</span>
              <div className="flex flex-col">
                <span className="mb-1 text-[10px] text-gray-400">To</span>
                <select
                  value={monthTo}
                  onChange={e => setMonthTo(Number(e.target.value))}
                  className="w-28 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer"
                >
                  {MONTH_LABELS.filter((_, i) => i + 1 >= Math.max(monthFrom, minMonth)).map(m => (
                    <option key={m} value={MONTH_LABELS.indexOf(m) + 1}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Currency toggle + FX info bar */}
      {hasData && (
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

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}

      {/* Trend chart */}
      {hasData && (() => {
        const chartData = visibleMonths.map(m => ({ label: m.label, value: totals[m.key] ?? 0 }))
        const maxVal    = Math.max(...chartData.map(d => d.value), 1)
        const grandTotal = chartData.reduce((s, d) => s + d.value, 0)
        const W = 600, H = 130
        const PAD = { left: 50, right: 16, top: 14, bottom: 28 }
        const plotW = W - PAD.left - PAD.right
        const plotH = H - PAD.top - PAD.bottom
        const pts = chartData.map((d, i) => ({
          x: PAD.left + (chartData.length === 1 ? plotW / 2 : (i / (chartData.length - 1)) * plotW),
          y: PAD.top + plotH - (d.value / maxVal) * plotH,
          ...d,
        }))
        const polyline = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
        const areaPath = [
          `${pts[0].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}`,
          polyline,
          `${pts[pts.length - 1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}`,
        ].join(' ')
        const fmtShort = (n: number) =>
          n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
          : n >= 1_000   ? Math.round(n / 1_000) + 'K'
          : String(Math.round(n))

        return (
          <div className="border-b border-gray-100 bg-white px-7 py-5">
            <div className="mb-2 flex items-baseline gap-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Monthly Totals</p>
              <span className="text-sm font-bold text-[#2E7D32]">
                {currency === 'KES' ? 'KSh' : '₦'}{grandTotal.toLocaleString('en-NG', { maximumFractionDigits: 0 })}
                <span className="ml-1 text-xs font-normal text-gray-400">total</span>
              </span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
              {[0, 0.5, 1].map(frac => {
                const y = PAD.top + plotH - frac * plotH
                return (
                  <g key={frac}>
                    <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="#F3F4F6" strokeWidth="1" />
                    <text x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#9CA3AF">
                      {fmtShort(frac * maxVal)}
                    </text>
                  </g>
                )
              })}
              <polygon points={areaPath} fill="#2E7D32" fillOpacity="0.07" />
              <polyline points={polyline} fill="none" stroke="#2E7D32" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((p, i) => (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r="3.5" fill="#2E7D32" />
                  <text x={p.x} y={H - 5} textAnchor="middle" fontSize="9" fill="#6B7280">{p.label}</text>
                  <text x={p.x} y={p.y - 7} textAnchor="middle" fontSize="8" fill="#2E7D32" fontWeight="600">
                    {fmtShort(p.value)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        )
      })()}

      {/* Table */}
        {hasData ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="sticky left-0 bg-gray-50 px-7 py-2.5 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Week
                </th>
                {visibleMonths.map((m, i) => (
                  <th key={m.key} className="px-4 py-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    {m.label}
                    {i > 0 && <span className="ml-1 font-normal text-gray-300">vs {visibleMonths[i - 1].label}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, ri) => (
                <tr
                  key={ri}
                  className="border-b border-gray-100 transition-colors hover:bg-gray-50/60"
                >
                  <td className="sticky left-0 bg-white px-7 py-2 font-semibold text-gray-700">
                    {row.week ?? `Week ${ri + 1}`}
                  </td>
                  {visibleMonths.map((m, mi) => {
                    const val  = parseMoney(row[m.key])
                    const prev = mi > 0 ? parseMoney(row[visibleMonths[mi - 1].key]) : null
                    return (
                      <td key={m.key} className="px-4 py-2 text-right tabular-nums text-gray-700">
                        {fmtAmount(val)}
                        <TrendIcon current={val} prev={prev} />
                      </td>
                    )
                  })}
                </tr>
              ))}

              {/* Totals row */}
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                <td className="sticky left-0 bg-gray-50 px-7 py-2.5 text-[11px] font-bold uppercase tracking-widest text-gray-500">
                  Total
                </td>
                {visibleMonths.map((m, mi) => {
                  const val  = totals[m.key]
                  const prev = mi > 0 ? totals[visibleMonths[mi - 1].key] : null
                  return (
                    <td key={m.key} className="px-4 py-2.5 text-right tabular-nums text-gray-900">
                      {fmtAmount(val)}
                      <TrendIcon current={val} prev={prev} />
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200">
              <FiTrendingUp className="h-6 w-6" />
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
              <strong className="text-gray-900">{rows.length}</strong> weeks &nbsp;·&nbsp;
              <strong className="text-gray-900">{visibleMonths.length}</strong> months
              {execMs != null && <> &nbsp;·&nbsp; <span className="font-mono">{execMs}ms</span></>}
            </>
          ) : '—'}
        </p>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">Export as</span>
          <button
            onClick={handleExport}
            disabled={!hasData}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FiDownload className="h-3 w-3" /> EXCEL
          </button>
        </div>
      </div>

    </div>
  )
}
