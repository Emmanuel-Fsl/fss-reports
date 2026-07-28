'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { FiBarChart2, FiRotateCcw, FiMail, FiX, FiChevronDown } from 'react-icons/fi'
import { getAuth }                         from 'firebase/auth'
import { RECOVERY_METHODS_INSTITUTIONS }   from '@/lib/reports/recovery-methods.queries'

// ── Types ─────────────────────────────────────────────────────────────────────
type RawRow = Record<string, string | number | null>

interface ComboMetrics {
  combo:            string
  n_records:        number
  paying_customers: number
  revenue_sum:      number
  cost_sum:         number
  balance_sum:      number
  tvol_sum:         number
  revenue_per_rec:  number
  cost_per_rec:     number
  profit_per_rec:   number
  roi:              number | null
  rr_count:         number
  rr_value:         number | null
  ra_value:         number | null
}

// ── Constants ─────────────────────────────────────────────────────────────────
const COMBO_ORDER = [
  'Never(no cont.)',
  'None(no cont.)',
  'VB only',
  'SMS only',
  'SMS + VB',
  'Bot',
  'Agent Contact',
]

const COMBO_COLOR: Record<string, string> = {
  'Agent Contact':   '#2E7D32',
  'Bot':             '#6A1B9A',
  'SMS + VB':        '#1565C0',
  'SMS only':        '#0288D1',
  'VB only':         '#E65100',
  'None(no cont.)':  '#78909C',
  'Never(no cont.)': '#B0BEC5',
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function num(v: string | number | null | undefined): number {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0
}

function fmtMoney(n: number): string {
  const neg = n < 0
  const abs = Math.abs(n)
  let s: string
  if (abs >= 1_000_000) s = (abs / 1_000_000).toFixed(2) + 'M'
  else if (abs >= 1_000) s = (abs / 1_000).toFixed(1)    + 'K'
  else                   s = Math.round(abs).toLocaleString()
  return (neg ? '-' : '') + '₦' + s
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}

function fmtROI(n: number | null): string {
  if (n == null || !isFinite(n)) return 'N/A'
  return n.toFixed(2) + '×'
}

function aggregateRows(rows: RawRow[]): RawRow[] {
  const byClient: Record<string, RawRow[]> = {}
  for (const row of rows) {
    const key = String(row.client_id ?? row.institution ?? '__')
    if (!byClient[key]) byClient[key] = []
    byClient[key].push(row)
  }
  return Object.values(byClient).map(clientRows => {
    const sorted = [...clientRows].sort((a, b) =>
      String(a.date ?? '').localeCompare(String(b.date ?? '')))
    const last = sorted[sorted.length - 1]
    const agg: RawRow = { ...last }
    for (const col of ['daily_sms_success','daily_vb_outbound','daily_agent_outbound','combined_bot',
                        'weekly_deposit_all','total_value_of_lead','daily_vb_out_cost',
                        'daily_sms_cost','weekly_outbound_cost','loan_count']) {
      agg[col] = sorted.reduce((s, r) => s + num(r[col]), 0)
    }
    agg['final_balance'] = num(last['final_balance'])
    agg['cum_rec']       = Math.max(...sorted.map(r => num(r['cum_rec'])))
    for (const col of ['total_assigned_amount_due','max_days_in_arrears']) {
      agg[col] = Math.max(...sorted.map(r => num(r[col])))
    }
    return agg
  })
}

function getCombo(row: RawRow): string {
  const sms = num(row.daily_sms_success)
  const vb  = num(row.daily_vb_outbound)
  const out = num(row.daily_agent_outbound)
  const bot = num(row.combined_bot)
  const cum = num(row.cum_rec)

  if (out > 0)           return 'Agent Contact'
  if (bot > 0)           return 'Bot'
  if (sms > 0 && vb > 0) return 'SMS + VB'
  if (vb > 0)            return 'VB only'
  if (sms > 0)           return 'SMS only'
  if (cum > 0)           return 'None(no cont.)'
  return 'Never(no cont.)'
}

function buildComboMetrics(rows: RawRow[]): ComboMetrics[] {
  const acc: Record<string, Omit<ComboMetrics, 'revenue_per_rec'|'cost_per_rec'|'profit_per_rec'|'roi'|'rr_count'|'rr_value'|'ra_value'>> = {}

  for (const row of rows) {
    const combo   = getCombo(row)
    const deposit = num(row.weekly_deposit_all)
    const cost    = num(row.daily_sms_cost) + num(row.daily_vb_out_cost) + num(row.weekly_outbound_cost)
    const balance = num(row.final_balance)
    const tvol    = num(row.total_value_of_lead)

    if (!acc[combo]) {
      acc[combo] = { combo, n_records: 0, paying_customers: 0, revenue_sum: 0, cost_sum: 0, balance_sum: 0, tvol_sum: 0 }
    }
    acc[combo].n_records++
    if (deposit > 0) acc[combo].paying_customers++
    acc[combo].revenue_sum  += deposit
    acc[combo].cost_sum     += cost
    acc[combo].balance_sum  += balance
    acc[combo].tvol_sum     += tvol
  }

  return COMBO_ORDER
    .filter(c => acc[c])
    .map(c => {
      const m = acc[c]
      const revenue_per_rec  = m.n_records        > 0 ? m.revenue_sum  / m.n_records         : 0
      const cost_per_rec     = m.n_records        > 0 ? m.cost_sum     / m.n_records         : 0
      const profit_per_rec   = revenue_per_rec - cost_per_rec
      const roi              = cost_per_rec       > 0 ? profit_per_rec / cost_per_rec         : null
      const rr_count         = m.n_records        > 0 ? m.paying_customers / m.n_records      : 0
      const rr_value         = m.balance_sum      > 0 ? m.revenue_sum / m.balance_sum         : null
      const ra_value         = m.paying_customers > 0 ? m.revenue_sum / m.paying_customers    : null
      return { ...m, revenue_per_rec, cost_per_rec, profit_per_rec, roi, rr_count, rr_value, ra_value }
    })
}

// ── Sub-components ────────────────────────────────────────────────────────────
function HBarChart({
  data, title,
}: {
  data:  { label: string; value: number; color: string }[]
  title: string
}) {
  const filtered = data.filter(d => isFinite(d.value))
  if (!filtered.length) return null
  const maxAbs  = Math.max(...filtered.map(d => Math.abs(d.value)), 1)
  const BAR_H   = 30
  const LABEL_W = 112
  const BAR_AREA = 240
  const height  = filtered.length * BAR_H + 12

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">{title}</p>
      <svg viewBox={`0 0 ${LABEL_W + BAR_AREA + 60} ${height}`} className="w-full" style={{ height }}>
        {filtered.map((d, i) => {
          const y    = i * BAR_H + 2
          const barW = Math.max((Math.abs(d.value) / maxAbs) * BAR_AREA, 3)
          const neg  = d.value < 0
          const abs  = Math.abs(d.value)
          const lbl  = abs >= 1_000_000
            ? (abs / 1_000_000).toFixed(1) + 'M'
            : abs >= 1_000 ? (abs / 1_000).toFixed(1) + 'K'
            : Math.round(abs).toString()
          return (
            <g key={d.label}>
              <text x={LABEL_W - 6} y={y + 16} textAnchor="end" fontSize="9.5" fill="#374151">
                {d.label}
              </text>
              <rect
                x={LABEL_W} y={y + 5}
                width={barW} height={BAR_H - 12}
                rx="3"
                fill={neg ? '#EF4444' : d.color}
                opacity={0.85}
              />
              <text x={LABEL_W + barW + 5} y={y + 16} fontSize="9" fill="#6B7280">
                {neg ? '-' : ''}₦{lbl}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function RRChart({
  data, title,
}: {
  data:  { label: string; value: number; color: string }[]
  title: string
}) {
  const filtered = data.filter(d => isFinite(d.value) && d.value > 0)
  if (!filtered.length) return null
  const max     = Math.max(...filtered.map(d => d.value), 0.01)
  const BAR_H   = 30
  const LABEL_W = 112
  const BAR_AREA = 180
  const height  = filtered.length * BAR_H + 12

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">{title}</p>
      <svg viewBox={`0 0 ${LABEL_W + BAR_AREA + 60} ${height}`} className="w-full" style={{ height }}>
        {filtered.map((d, i) => {
          const y    = i * BAR_H + 2
          const barW = Math.max((d.value / max) * BAR_AREA, 3)
          return (
            <g key={d.label}>
              <text x={LABEL_W - 6} y={y + 16} textAnchor="end" fontSize="9.5" fill="#374151">
                {d.label}
              </text>
              <rect
                x={LABEL_W} y={y + 5}
                width={barW} height={BAR_H - 12}
                rx="3" fill={d.color} opacity={0.8}
              />
              <text x={LABEL_W + barW + 5} y={y + 16} fontSize="9" fill="#6B7280">
                {(d.value * 100).toFixed(1)}%
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function MetricsTable({ metrics }: { metrics: ComboMetrics[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full min-w-[860px] text-[11.5px]">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            {['Contact Method', 'Records', 'Payers', 'Rec. Rate', 'Avg Revenue', 'Avg Cost', 'Profit/Rec', 'ROI', 'Avg/Payer'].map(h => (
              <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 first:rounded-tl-lg last:rounded-tr-lg">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map((m, i) => {
            const isProfit = m.profit_per_rec > 0
            return (
              <tr key={m.combo} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                <td className="px-3 py-2 font-semibold" style={{ color: COMBO_COLOR[m.combo] ?? '#374151' }}>
                  <span
                    className="inline-block h-2 w-2 rounded-full mr-1.5 align-middle"
                    style={{ background: COMBO_COLOR[m.combo] ?? '#9E9E9E' }}
                  />
                  {m.combo}
                </td>
                <td className="px-3 py-2 font-mono text-gray-700">{m.n_records.toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-gray-700">{m.paying_customers.toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-gray-700">{fmtPct(m.rr_count)}</td>
                <td className="px-3 py-2 font-mono text-gray-700">{fmtMoney(m.revenue_per_rec)}</td>
                <td className="px-3 py-2 font-mono text-gray-700">{fmtMoney(m.cost_per_rec)}</td>
                <td className={`px-3 py-2 font-mono font-semibold ${isProfit ? 'text-green-700' : 'text-red-600'}`}>
                  {fmtMoney(m.profit_per_rec)}
                </td>
                <td className={`px-3 py-2 font-mono font-semibold ${(m.roi ?? 0) >= 1 ? 'text-green-700' : 'text-red-600'}`}>
                  {fmtROI(m.roi)}
                </td>
                <td className="px-3 py-2 font-mono text-gray-700">
                  {m.ra_value != null ? fmtMoney(m.ra_value) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Module-level cache ────────────────────────────────────────────────────────
interface Snapshot {
  rows:      RawRow[]
  dateFrom:  string
  dateTo:    string
  depositTo: string
  insts:     string[]
}
let _cache: Snapshot | null = null

// ── Main Component ────────────────────────────────────────────────────────────
export default function RecoveryMethodsView() {
  const cached = _cache

  const [dateFrom,     setDateFrom]     = useState(cached?.dateFrom  ?? '2026-04-11')
  const [dateTo,       setDateTo]       = useState(cached?.dateTo    ?? '2026-04-18')
  const [depositTo,    setDepositTo]    = useState(cached?.depositTo ?? '')
  const [insts,        setInsts]        = useState<string[]>(cached?.insts ?? [])
  const [rows,         setRows]         = useState<RawRow[]>(cached?.rows ?? [])
  const [hasData,      setHasData]      = useState(!!cached)
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')

  const [instOpen,     setInstOpen]     = useState(false)
  const instDropdownRef = useRef<HTMLDivElement>(null)

  const [emailOpen,      setEmailOpen]      = useState(false)
  const [emailTo,        setEmailTo]        = useState('')
  const [emailDateFrom,  setEmailDateFrom]  = useState('2026-04-11')
  const [emailDateTo,    setEmailDateTo]    = useState('2026-04-18')
  const [emailDepositTo, setEmailDepositTo] = useState('')
  const [emailInsts,     setEmailInsts]     = useState<string[]>([])
  const [emailInstOpen,  setEmailInstOpen]  = useState(false)
  const [emailSending,   setEmailSending]   = useState(false)
  const [emailStatus,    setEmailStatus]    = useState<{ ok: boolean; msg: string } | null>(null)
  const emailInputRef  = useRef<HTMLTextAreaElement>(null)
  const emailInstRef   = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (emailInstRef.current && !emailInstRef.current.contains(e.target as Node)) {
        setEmailInstOpen(false)
      }
    }
    if (emailInstOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [emailInstOpen])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (instDropdownRef.current && !instDropdownRef.current.contains(e.target as Node)) {
        setInstOpen(false)
      }
    }
    if (instOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [instOpen])

  // ── Run (disabled until browser rendering is set up) ────────────────────────
  // const runReport = useCallback(async () => {
  //   setLoading(true)
  //   setError('')
  //   try {
  //     const user  = getAuth().currentUser
  //     const token = await user?.getIdToken()
  //     const body: Record<string, unknown> = { dateFrom, dateTo, institutions: insts }
  //     if (depositTo && depositTo > dateTo) body.depositTo = depositTo
  //     const res   = await fetch('/api/reports/recovery-methods/run', {
  //       method:  'POST',
  //       headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  //       body:    JSON.stringify(body),
  //     })
  //     if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
  //     const data = await res.json()
  //     setRows(data.rows)
  //     setHasData(true)
  //     _cache = { rows: data.rows, dateFrom, dateTo, depositTo, insts }
  //   } catch (err: any) {
  //     setError(err.message)
  //   } finally {
  //     setLoading(false)
  //   }
  // }, [dateFrom, dateTo, depositTo, insts])

  function resetFilters() {
    setDateFrom('2026-04-11')
    setDateTo('2026-04-18')
    setDepositTo('')
    setInsts([])
    setRows([])
    setHasData(false)
    _cache = null
  }


  // ── Aggregation ──────────────────────────────────────────────────────────────
  const stackedRows = useMemo(() => aggregateRows(rows), [rows])

  const institutions: string[] = useMemo(() => {
    const set = new Set<string>()
    for (const r of stackedRows) if (r.institution) set.add(String(r.institution))
    return RECOVERY_METHODS_INSTITUTIONS.filter(i => set.has(i))
  }, [stackedRows])

  const instMetrics = useMemo(() => {
    const result: Record<string, ComboMetrics[]> = {}
    for (const institution of institutions) {
      result[institution] = buildComboMetrics(stackedRows.filter((r: RawRow) => r.institution === institution))
    }
    return result
  }, [stackedRows, institutions])

  const overall = useMemo(() => {
    const total_records  = stackedRows.length
    const paying         = stackedRows.filter(r => num(r.weekly_deposit_all) > 0).length
    const revenue        = stackedRows.reduce((s, r) => s + num(r.weekly_deposit_all), 0)
    const cost           = stackedRows.reduce((s, r) => s + num(r.daily_sms_cost) + num(r.daily_vb_out_cost) + num(r.weekly_outbound_cost), 0)
    const profit         = revenue - cost
    const rr             = total_records > 0 ? paying / total_records : 0
    return { total_records, paying, revenue, cost, profit, rr }
  }, [stackedRows])

  // ── Email ────────────────────────────────────────────────────────────────────
  const sendEmail = useCallback(async () => {
    const recipients = emailTo.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
    if (!recipients.length) return
    setEmailSending(true)
    setEmailStatus(null)
    try {
      const user  = getAuth().currentUser
      const token = await user?.getIdToken()
      const res = await fetch('/api/reports/recovery-methods/email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to:           recipients,
          dateFrom:     emailDateFrom,
          dateTo:       emailDateTo,
          depositTo:    emailDepositTo || undefined,
          institutions: emailInsts.length ? emailInsts : undefined,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Send failed')
      setEmailStatus({ ok: true, msg: `Sent! This may take 5–20 minutes to arrive in your inbox.` })
      setEmailTo('')
    } catch (err: any) {
      setEmailStatus({ ok: false, msg: err.message })
    } finally {
      setEmailSending(false)
    }
  }, [emailTo, emailDateFrom, emailDateTo, emailDepositTo, emailInsts])

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col">

      {/* Topbar */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Recovery Methods Report</h1>
          <p className="mt-0.5 text-xs text-gray-400">
            Contact method effectiveness by institution — profit, ROI and recovery rate per outreach type
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
            onClick={() => { setEmailOpen(true); setEmailStatus(null); setEmailInsts(insts) }}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-50"
          >
            <FiMail className="h-3 w-3" />
            Email Report
          </button>
          {/* Run Report button — disabled until browser rendering is set up
          <button
            onClick={runReport}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md bg-[#2E7D32] px-4 py-1.5 text-xs font-bold text-white transition hover:bg-[#1B5E20] disabled:opacity-60"
          >
            {loading
              ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              : <FiPlay className="h-3 w-3" />
            }
            Run Report
          </button>
          */}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-shrink-0 flex-wrap items-end gap-4 border-b border-gray-200 bg-gray-50 px-7 py-3">
        <div className="flex flex-col gap-1" ref={instDropdownRef}>
          <label className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Institution</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setInstOpen(o => !o)}
              className="flex min-w-[180px] items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
            >
              <span>
                {insts.length === 0
                  ? 'All Institutions'
                  : `${insts.length} / ${RECOVERY_METHODS_INSTITUTIONS.length} selected`}
              </span>
              <FiChevronDown className={`h-3 w-3 text-gray-400 transition-transform ${instOpen ? 'rotate-180' : ''}`} />
            </button>
            {instOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-full min-w-[200px] rounded-md border border-gray-200 bg-white shadow-lg">
                <button
                  type="button"
                  onClick={() => setInsts([])}
                  className="w-full px-3 py-2 text-left text-xs font-semibold text-gray-500 hover:bg-gray-50 border-b border-gray-100"
                >
                  All Institutions
                </button>
                {RECOVERY_METHODS_INSTITUTIONS.map(i => (
                  <label key={i} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={insts.includes(i)}
                      onChange={e => setInsts(prev =>
                        e.target.checked ? [...prev, i] : prev.filter(x => x !== i)
                      )}
                      className="accent-[#2E7D32]"
                    />
                    {i}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Date From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Date To</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
            Deposit To
            <span className="ml-1 normal-case font-normal text-gray-400">(optional)</span>
          </label>
          <input
            type="date"
            value={depositTo}
            min={dateTo}
            onChange={e => setDepositTo(e.target.value)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
          />
        </div>

      </div>

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">{error}</div>
      )}

      {/* Overall stats bar */}
      {hasData && (
        <div className="flex flex-shrink-0 flex-wrap gap-x-8 gap-y-3 border-b border-gray-200 bg-white px-7 py-4">
          {[
            { label: 'Total Records',    value: overall.total_records.toLocaleString() },
            { label: 'Paying Customers', value: overall.paying.toLocaleString()        },
            { label: 'Recovery Rate',    value: fmtPct(overall.rr)                     },
            { label: 'Total Revenue',    value: fmtMoney(overall.revenue)              },
            { label: 'Total Cost',       value: fmtMoney(overall.cost)                 },
            { label: 'Total Profit',     value: fmtMoney(overall.profit), highlight: overall.profit > 0 },
          ].map(s => (
            <div key={s.label}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{s.label}</p>
              <p className={`mt-0.5 text-[15px] font-bold ${s.highlight === false ? 'text-red-600' : s.highlight ? 'text-green-700' : 'text-gray-900'}`}>
                {s.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasData ? (
          <div className="px-7 py-6 space-y-10">

            {/* All-institutions combined */}
            {insts.length === 0 && (
              <section>
                <h2 className="mb-4 text-[13px] font-bold text-gray-800">All Institutions — Combined</h2>
                <MetricsTable metrics={buildComboMetrics(stackedRows)} />
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <HBarChart
                    title="Profit per Record by Contact Method"
                    data={buildComboMetrics(stackedRows).map(m => ({
                      label: m.combo, value: m.profit_per_rec, color: COMBO_COLOR[m.combo] ?? '#9E9E9E',
                    }))}
                  />
                  <RRChart
                    title="Recovery Rate by Contact Method"
                    data={buildComboMetrics(stackedRows).map(m => ({
                      label: m.combo, value: m.rr_count, color: COMBO_COLOR[m.combo] ?? '#9E9E9E',
                    }))}
                  />
                </div>
              </section>
            )}

            {/* Per-institution */}
            {institutions.map(institution => (
              <section key={institution}>
                <h2 className="mb-1 text-[13px] font-bold text-gray-800">{institution}</h2>
                <p className="mb-4 text-[10px] text-gray-400">
                  {stackedRows.filter(r => r.institution === institution).length.toLocaleString()} records
                </p>
                <MetricsTable metrics={instMetrics[institution] ?? []} />
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <HBarChart
                    title="Profit per Record"
                    data={(instMetrics[institution] ?? []).map(m => ({
                      label: m.combo, value: m.profit_per_rec, color: COMBO_COLOR[m.combo] ?? '#9E9E9E',
                    }))}
                  />
                  <RRChart
                    title="Recovery Rate"
                    data={(instMetrics[institution] ?? []).map(m => ({
                      label: m.combo, value: m.rr_count, color: COMBO_COLOR[m.combo] ?? '#9E9E9E',
                    }))}
                  />
                </div>
              </section>
            ))}

          </div>
        ) : !loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <FiBarChart2 className="mb-3 h-10 w-10 text-gray-200" />
            <p className="text-sm font-semibold text-gray-400">Select filters and run the report</p>
          </div>
        ) : null}
      </div>

      {/* Email modal */}
      {emailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="relative w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
            <button
              onClick={() => { setEmailOpen(false); setEmailStatus(null) }}
              className="absolute right-4 top-4 text-gray-400 hover:text-gray-600"
            >
              <FiX className="h-4 w-4" />
            </button>

            <div className="mb-4 flex items-center gap-2">
              <FiMail className="h-4 w-4 text-[#2E7D32]" />
              <h2 className="text-sm font-bold text-gray-900">Email Report</h2>
            </div>

            {/* Date range */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Date From</label>
                <input
                  type="date"
                  value={emailDateFrom}
                  onChange={e => setEmailDateFrom(e.target.value)}
                  className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Date To</label>
                <input
                  type="date"
                  value={emailDateTo}
                  onChange={e => setEmailDateTo(e.target.value)}
                  className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
                />
              </div>
            </div>
            <div className="mb-3">
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Deposit To <span className="normal-case font-normal text-gray-400">(optional — extended period)</span></label>
              <input
                type="date"
                value={emailDepositTo}
                onChange={e => setEmailDepositTo(e.target.value)}
                className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
              />
            </div>

            {/* Institution selector */}
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Institutions</label>
            <div className="relative mb-3" ref={emailInstRef}>
              <button
                type="button"
                onClick={() => setEmailInstOpen(o => !o)}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none"
              >
                <span>
                  {emailInsts.length === 0
                    ? 'All Institutions'
                    : `${emailInsts.length} / ${RECOVERY_METHODS_INSTITUTIONS.length} selected`}
                </span>
                <FiChevronDown className={`h-3 w-3 text-gray-400 transition-transform ${emailInstOpen ? 'rotate-180' : ''}`} />
              </button>
              {emailInstOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
                  <button
                    type="button"
                    onClick={() => setEmailInsts([])}
                    className="w-full px-3 py-2 text-left text-xs font-semibold text-gray-500 hover:bg-gray-50 border-b border-gray-100"
                  >
                    All Institutions
                  </button>
                  {RECOVERY_METHODS_INSTITUTIONS.map(i => (
                    <label key={i} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={emailInsts.includes(i)}
                        onChange={e => setEmailInsts(prev =>
                          e.target.checked ? [...prev, i] : prev.filter(x => x !== i)
                        )}
                        className="accent-[#2E7D32]"
                      />
                      {i}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Recipients */}
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Recipients</label>
            <textarea
              ref={emailInputRef}
              value={emailTo}
              onChange={e => setEmailTo(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
              rows={2}
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-700 focus:border-[#2E7D32] focus:outline-none resize-none"
            />

            {emailStatus && (
              <div className={`mt-2 rounded-md px-3 py-2 text-xs font-semibold ${emailStatus.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                {emailStatus.ok ? '✓ ' : '✗ '}{emailStatus.msg}
              </div>
            )}

            <button
              onClick={sendEmail}
              disabled={emailSending || !emailTo.trim()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-[#2E7D32] py-2 text-xs font-bold text-white transition hover:bg-[#1B5E20] disabled:opacity-50"
            >
              {emailSending
                ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                : <FiMail className="h-3 w-3" />
              }
              {emailSending ? 'Generating & sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
