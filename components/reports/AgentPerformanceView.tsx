'use client'

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { FiDownload, FiPlay, FiRotateCcw, FiUsers } from 'react-icons/fi'
import { getAuth }               from 'firebase/auth'
import { ALL_INSTITUTIONS }      from '@/lib/reports/reports.config'
import { downloadExcel }         from '@/lib/reports/export'
import {
  AGENT_CORE_COLUMNS,
  AGENT_EXTRA_COLUMNS,
  CALL_TARGET_PER_DAY,
  WA_TARGET_PER_DAY,
  REACH_TARGET_PER_DAY,
  WEIGHT_CONTACT,
  WEIGHT_PTP,
  WEIGHT_CONVERSION,
  WEIGHT_AMOUNT,
  type AgentMode,
}                                from '@/lib/reports/agent-performance'
import type { ReportRow, ColumnDef } from '@/types'
import clsx                      from 'clsx'

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseMoney(v: string | number | null | undefined): number {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0
}

function fmtAmount(n: number, currency: 'NGN' | 'KES'): string {
  const sym = currency === 'NGN' ? '₦' : 'KSh'
  return sym + '\u00a0' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return '—'
  return (Number(n) * 100).toFixed(1) + '%'
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

// Amounts from the API are always in NGN (the BQ query already converts KES → NGN).
// fxRate = ngn_per_unit, i.e. 1 KES = fxRate NGN (e.g. 10.5)
// To display in KES: divide NGN by fxRate
function toDisplayAmount(ngnAmount: number, currency: 'NGN' | 'KES', fxRate: number): number {
  return currency === 'KES' ? ngnAmount / fxRate : ngnAmount
}

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

// ── Module-level cache ────────────────────────────────────────────────────────
interface AgentPerfSnapshot {
  rows:                  ReportRow[]
  fxRate:                number
  mode:                  AgentMode
  dateFrom:              string
  dateTo:                string
  includedInstitutions:  string[]
  execMs:                number | null
}
let _cache: AgentPerfSnapshot | null = null

// ── SVG Bar Chart ─────────────────────────────────────────────────────────────
function BarChart({
  data, currency, fxRate, title, color, ratio = false,
}: {
  data:     { label: string; value: number }[]
  currency: 'NGN' | 'KES'
  fxRate:   number
  title:    string
  color:    string
  ratio?:   boolean
}) {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    setGrown(false)
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)))
    return () => cancelAnimationFrame(id)
  }, [data])

  const displayData = data.map(d => ({ ...d, display: toDisplayAmount(d.value, currency, fxRate) }))
  const max = Math.max(...displayData.map(d => d.display), 1)
  const BAR_H = 28
  const height = displayData.length * BAR_H + 20
  const LABEL_W = 88

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-gray-400">{title}</p>
      <svg viewBox={`0 0 400 ${height}`} className="w-full" style={{ height }}>
        {displayData.map((d, i) => {
          const y      = i * BAR_H + 4
          const barW   = Math.max((d.display / max) * (400 - LABEL_W - 60), 4)
          const fmtVal = ratio
            ? d.display.toFixed(3)
            : d.display >= 1000
              ? (d.display >= 1_000_000
                ? fmtAmount(Math.round(d.display / 1_000_000), currency) + 'M'
                : fmtAmount(Math.round(d.display / 1_000), currency) + 'K')
              : fmtAmount(d.display, currency)
          return (
            <g key={d.label}>
              <text x={LABEL_W - 4} y={y + 14} textAnchor="end" fontSize="10" fill="#6B7280">
                {d.label}
              </text>
              <rect
                x={LABEL_W} y={y + 2} width={grown ? barW : 0} height="18" rx="3" fill={color}
                style={{ transition: 'width 800ms ease-out', transitionDelay: `${i * 45}ms` }}
              />
              <text
                x={LABEL_W + (grown ? barW : 0) + 4} y={y + 14} fontSize="9" fill="#9CA3AF"
                style={{ transition: 'opacity 400ms ease-out, x 800ms ease-out', transitionDelay: `${i * 45}ms`, opacity: grown ? 1 : 0 }}
              >
                {fmtVal}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function MetricChart({
  data, title,
}: {
  data:  { label: string; contacts: number; ptp: number; conversion: number }[]
  title: string
}) {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    setGrown(false)
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)))
    return () => cancelAnimationFrame(id)
  }, [data])

  const maxContacts = Math.max(...data.map(d => d.contacts), 1)
  const maxPtp      = Math.max(...data.map(d => d.ptp), 1)
  const BAR_H    = 28
  const height   = data.length * BAR_H + 20
  const LABEL_W  = 88
  const TRACK_W  = 300 - LABEL_W

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-gray-400">{title}</p>
      <div className="mb-2 flex gap-4 text-[10px] text-gray-400">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-400" />Contacts</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />PTPs</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#2E7D32]" />Conv %</span>
      </div>
      <svg viewBox={`0 0 300 ${height}`} className="w-full" style={{ height }}>
        {data.map((d, i) => {
          const y         = i * BAR_H + 4
          const contactsW = (d.contacts    / maxContacts) * TRACK_W
          const ptpW      = (d.ptp         / maxPtp)      * TRACK_W
          const convW     = Math.min(d.conversion, 1)     * TRACK_W
          const delay     = `${i * 45}ms`
          return (
            <g key={d.label}>
              <text x={LABEL_W - 4} y={y + 14} textAnchor="end" fontSize="10" fill="#6B7280">
                {d.label}
              </text>
              {/* stacked thin bars */}
              <rect
                x={LABEL_W} y={y + 2}  width={grown ? contactsW : 0} height="5" rx="2" fill="#60A5FA"
                style={{ transition: 'width 800ms ease-out', transitionDelay: delay }}
              />
              <rect
                x={LABEL_W} y={y + 9}  width={grown ? ptpW : 0}      height="5" rx="2" fill="#FBBF24"
                style={{ transition: 'width 800ms ease-out', transitionDelay: delay }}
              />
              <rect
                x={LABEL_W} y={y + 16} width={grown ? convW : 0}     height="5" rx="2" fill="#2E7D32"
                style={{ transition: 'width 800ms ease-out', transitionDelay: delay }}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── What-If Simulator ─────────────────────────────────────────────────────────
// Reimplements the scoring formula from agent-performance.queries.ts client-side
// so tweaking one agent's numbers re-ranks instantly against the other agents'
// currently-loaded (real) values — no BigQuery round-trip. Constants are
// imported from the shared client-safe module so this can never drift from
// what the server actually computes.
type SimNumericKey = 'calls' | 'wa' | 'reach' | 'ptp' | 'converted' | 'amount' | 'contacted' | 'assigned'

interface SimAgent {
  agent:     string
  calls:     number
  wa:        number
  reach:     number
  ptp:       number
  converted: number
  amount:    number
  contacted: number
  assigned:  number
}

function buildSimBaseline(rows: ReportRow[]): SimAgent[] {
  return rows.map(r => ({
    agent:     String(r.agent),
    calls:     parseMoney(r.total_calls),
    wa:        parseMoney(r.total_whatsapp),
    reach:     parseMoney(r.total_reach_days),
    ptp:       parseMoney(r.total_ptp),
    converted: parseMoney(r.total_converted),
    amount:    parseMoney(r.total_amount),
    contacted: parseMoney(r.customers_contacted),
    assigned:  parseMoney(r.amount_assigned),
  }))
}

function workingDaysBetween(df: string, dt: string): number {
  const start = new Date(`${df}T00:00:00Z`)
  const end   = new Date(`${dt}T00:00:00Z`)
  let count = 0
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay() // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) count++
  }
  return count
}

// Standard-competition rank (ties share a rank; next rank skips) — same
// semantics as BigQuery's RANK() OVER (ORDER BY ... DESC).
function rankDesc(values: number[]): number[] {
  return values.map(v => 1 + values.filter(x => x > v).length)
}

interface SimResult {
  contactAtt:  number[]
  ptpRate:     number[]
  convRate:    number[]
  amtRate:     number[]
  weighted:    number[]
  overallRank: number[]
  contactRank: number[]
  ptpRank:     number[]
  convRank:    number[]
  amtRank:     number[]
}

function computeSim(agents: SimAgent[], workingDays: number): SimResult {
  const n = agents.length
  const callTarget  = CALL_TARGET_PER_DAY  * workingDays
  const waTarget    = WA_TARGET_PER_DAY    * workingDays
  const reachTarget = REACH_TARGET_PER_DAY * workingDays

  const contactAtt = agents.map(a => {
    const c = callTarget  ? Math.min(1, a.calls / callTarget)  : 0
    const w = waTarget    ? Math.min(1, a.wa    / waTarget)    : 0
    const r = reachTarget ? Math.min(1, a.reach / reachTarget) : 0
    return (c + w + r) / 3
  })
  const ptpRate  = agents.map(a => a.contacted ? a.ptp / a.contacted : 0)
  const convRate = agents.map(a => a.ptp       ? a.converted / a.ptp : 0)
  const amtRate  = agents.map(a => a.assigned  ? a.amount / a.assigned : 0)

  const ptpRateRank  = rankDesc(ptpRate)
  const ptpVolRank   = rankDesc(agents.map(a => a.ptp))
  const convRateRank = rankDesc(convRate)
  const convVolRank  = rankDesc(agents.map(a => a.converted))
  const amtRateRank  = rankDesc(amtRate)
  const amtVolRank   = rankDesc(agents.map(a => a.amount))

  const dim = (rr: number, vr: number) => ((n - rr) / (n - 1) + (n - vr) / (n - 1)) / 2
  const ptpDim  = agents.map((_, i) => dim(ptpRateRank[i],  ptpVolRank[i]))
  const convDim = agents.map((_, i) => dim(convRateRank[i], convVolRank[i]))
  const amtDim  = agents.map((_, i) => dim(amtRateRank[i],  amtVolRank[i]))

  const weighted = agents.map((_, i) =>
    WEIGHT_CONTACT * contactAtt[i] + WEIGHT_PTP * ptpDim[i] + WEIGHT_CONVERSION * convDim[i] + WEIGHT_AMOUNT * amtDim[i],
  )

  return {
    contactAtt, ptpRate, convRate, amtRate, weighted,
    overallRank: rankDesc(weighted),
    contactRank: rankDesc(contactAtt),
    ptpRank:     rankDesc(ptpDim),
    convRank:    rankDesc(convDim),
    amtRank:     rankDesc(amtDim),
  }
}

const SIM_CONTACT_FIELDS: { key: SimNumericKey; label: string }[] = [
  { key: 'calls', label: 'Calls' },
  { key: 'wa',    label: 'WhatsApp' },
  { key: 'reach', label: 'Reach (contact-days)' },
]
const SIM_OUTCOME_FIELDS: { key: SimNumericKey; label: string; money?: boolean }[] = [
  { key: 'ptp',       label: 'PTPs' },
  { key: 'converted', label: 'Converted PTPs' },
  { key: 'amount',    label: 'Amount recovered', money: true },
  { key: 'contacted', label: 'Customers contacted' },
  { key: 'assigned',  label: 'Portfolio assigned',  money: true },
]

function AgentScoreSimulator({
  rows, dateFrom, dateTo, formatAmount,
}: {
  rows:         ReportRow[]
  dateFrom:     string
  dateTo:       string
  formatAmount: (v: number) => string
}) {
  const baseline    = useMemo(() => buildSimBaseline(rows), [rows])
  const workingDays = useMemo(() => workingDaysBetween(dateFrom, dateTo), [dateFrom, dateTo])
  const baseResult  = useMemo(() => computeSim(baseline, workingDays), [baseline, workingDays])

  const [state,    setState]    = useState<SimAgent[]>(() => baseline.map(a => ({ ...a })))
  const [selected, setSelected] = useState(0)

  const result = useMemo(() => computeSim(state, workingDays), [state, workingDays])

  const fieldMax = useMemo(() => {
    const maxes: Record<string, number> = {}
    for (const f of [...SIM_CONTACT_FIELDS, ...SIM_OUTCOME_FIELDS]) {
      maxes[f.key] = Math.max(...baseline.map(a => a[f.key]), 1) * 2.5
    }
    return maxes
  }, [baseline])

  function updateField(key: SimNumericKey, value: number) {
    setState(prev => prev.map((a, i) => (i === selected ? { ...a, [key]: value } : a)))
  }
  function resetAll() {
    setState(baseline.map(a => ({ ...a })))
  }

  // FLIP-animate leaderboard row reorders
  const rowRefs   = useRef(new Map<string, HTMLTableRowElement>())
  const prevRects = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const newRects = new Map<string, DOMRect>()
    rowRefs.current.forEach((el, name) => newRects.set(name, el.getBoundingClientRect()))
    rowRefs.current.forEach((el, name) => {
      const prev = prevRects.current.get(name)
      const next = newRects.get(name)
      if (prev && next) {
        const dy = prev.top - next.top
        if (dy) {
          el.style.transition = 'none'
          el.style.transform = `translateY(${dy}px)`
          requestAnimationFrame(() => {
            el.style.transition = 'transform 380ms ease'
            el.style.transform = 'translateY(0)'
          })
        }
      }
    })
    prevRects.current = newRects
  }, [result])

  const order = state.map((_, i) => i).sort((a, b) => result.weighted[b] - result.weighted[a])
  const maxScore = Math.max(...result.weighted, 0.0001)

  const actualRank  = baseResult.overallRank[selected]
  const curRank     = result.overallRank[selected]
  const rankDelta   = actualRank - curRank // positive = improved

  return (
    <div className="px-7 py-4">
      <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5">
        <p className="text-xs text-blue-600">
          Drag any input to see how it moves this agent's weighted score and rank.
          The other agents stay fixed at their last-loaded values — this shows relative movement, not a forecast.
        </p>
        <button
          onClick={resetAll}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-600 transition hover:bg-blue-100"
        >
          <FiRotateCcw className="h-3 w-3" /> Reset to actual
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {state.map((a, i) => (
          <button
            key={a.agent}
            onClick={() => setSelected(i)}
            className={clsx(
              'flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-all',
              i === selected
                ? 'border-[#2E7D32] bg-[#E8F5E9] text-[#1B5E20]'
                : 'border-gray-200 bg-white text-gray-400 hover:border-[#2E7D32] hover:text-[#2E7D32]',
            )}
          >
            {a.agent}
            <span className="rounded border border-current px-1 font-mono text-[10px] tabular-nums opacity-70">
              #{result.overallRank[i]}
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Control deck */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 lg:col-span-3">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-gray-400">
            Control deck — {state[selected]?.agent}
          </p>

          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-300">Contact activity</p>
          {SIM_CONTACT_FIELDS.map(f => (
            <SimSliderRow
              key={f.key}
              label={f.label}
              value={state[selected][f.key]}
              actual={baseline[selected][f.key]}
              max={fieldMax[f.key]}
              onChange={v => updateField(f.key, v)}
            />
          ))}

          <p className="mb-2 mt-4 border-t border-dashed border-gray-200 pt-3 text-[10px] font-bold uppercase tracking-widest text-gray-300">Outcomes</p>
          {SIM_OUTCOME_FIELDS.map(f => (
            <SimSliderRow
              key={f.key}
              label={f.label}
              value={state[selected][f.key]}
              actual={baseline[selected][f.key]}
              max={fieldMax[f.key]}
              onChange={v => updateField(f.key, v)}
              format={f.money ? formatAmount : undefined}
            />
          ))}

          <p className="mt-4 border-t border-dashed border-gray-200 pt-3 text-[11px] text-gray-400">
            Grey tick on each track marks the agent's actual value. Ranks recompute live against the other agents' current numbers.
          </p>
        </div>

        {/* Live score + leaderboard */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-gray-400">Live score</p>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-mono text-4xl font-bold tabular-nums tracking-tight text-gray-900">
                  {(result.weighted[selected] * 100).toFixed(1)}%
                </div>
                <div className="mt-1 text-[11px] text-gray-400">Weighted score</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="font-mono text-2xl font-bold tabular-nums text-gray-900">#{curRank}</div>
                <div
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-[11px] font-bold',
                    rankDelta > 0 && 'bg-blue-50 text-blue-600',
                    rankDelta < 0 && 'bg-orange-50 text-orange-600',
                    rankDelta === 0 && 'bg-gray-100 text-gray-400',
                  )}
                >
                  {rankDelta > 0 ? `▲ ${rankDelta} vs actual` : rankDelta < 0 ? `▼ ${-rankDelta} vs actual` : '— matches actual'}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <SimStatChip label="Contact rank" rank={result.contactRank[selected]} sub={`${(result.contactAtt[selected] * 100).toFixed(1)}% attainment`} />
              <SimStatChip label="PTP rank"      rank={result.ptpRank[selected]}     sub={`${(result.ptpRate[selected] * 100).toFixed(1)}% rate`} />
              <SimStatChip label="Conv. rank"    rank={result.convRank[selected]}    sub={`${(result.convRate[selected] * 100).toFixed(1)}% rate`} />
              <SimStatChip label="Amount rank"   rank={result.amtRank[selected]}     sub={`${(result.amtRate[selected] * 100).toFixed(1)}% recovery`} />
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-gray-400">Leaderboard</p>
            <table className="w-full border-collapse text-[12.5px]">
              <tbody>
                {order.map(i => (
                  <tr
                    key={state[i].agent}
                    ref={el => { if (el) rowRefs.current.set(state[i].agent, el); else rowRefs.current.delete(state[i].agent) }}
                    className={clsx('border-b border-gray-100 last:border-0', i === selected && 'bg-[#E8F5E9]')}
                  >
                    <td className="w-8 py-2 font-mono text-gray-400 tabular-nums">#{result.overallRank[i]}</td>
                    <td className="py-2 font-semibold text-gray-800">{state[i].agent}</td>
                    <td className="py-2 text-right font-mono tabular-nums text-gray-700">{(result.weighted[i] * 100).toFixed(1)}%</td>
                    <td className="w-24 py-2 pl-3">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={clsx('h-full rounded-full transition-[width] duration-300', i === selected ? 'bg-blue-500' : 'bg-[#2E7D32]')}
                          style={{ width: `${Math.max(0, result.weighted[i]) / maxScore * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function SimSliderRow({
  label, value, actual, max, onChange, format,
}: {
  label:    string
  value:    number
  actual:   number
  max:      number
  onChange: (v: number) => void
  format?:  (v: number) => string
}) {
  const display = format ? format(value) : fmtNum(value)
  const delta = value - actual
  const deltaAbs = format ? format(Math.abs(delta)) : fmtNum(Math.abs(delta))
  const isActual = Math.abs(delta) < Math.max(max * 0.001, 0.5)

  return (
    <div className="grid grid-cols-[112px_1fr_100px] items-center gap-3 py-1.5">
      <label className="text-[12.5px] font-medium text-gray-700">{label}</label>
      <div className="relative flex h-5 items-center">
        <div
          className="pointer-events-none absolute h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-gray-300"
          style={{ left: `${Math.min(1, actual / max) * 100}%` }}
        />
        <input
          type="range"
          min={0}
          max={max}
          step={max > 100000 ? 1000 : 1}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="relative z-10 w-full accent-[#2E7D32]"
        />
      </div>
      <div className="text-right">
        <div className="font-mono text-[13px] font-bold tabular-nums text-gray-900">{display}</div>
        <div className={clsx('font-mono text-[10px] tabular-nums', isActual ? 'text-gray-300' : delta > 0 ? 'text-blue-500' : 'text-orange-500')}>
          {isActual ? 'actual' : `${delta > 0 ? '+' : '-'}${deltaAbs}`}
        </div>
      </div>
    </div>
  )
}

function SimStatChip({ label, rank, sub }: { label: string; rank: number; sub: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2">
      <div className="text-[9.5px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-bold tabular-nums text-gray-900">#{rank}</div>
      <div className="text-[10px] text-gray-400">{sub}</div>
    </div>
  )
}

// ── Input styles ──────────────────────────────────────────────────────────────
const labelCls = 'text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5 block'

// ── Component ─────────────────────────────────────────────────────────────────
export default function AgentPerformanceView() {
  const c = _cache

  // Default to current month
  const now       = new Date()
  const defFrom   = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const lastDay   = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const defTo     = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const [mode,                 setMode]                 = useState<AgentMode>(c?.mode ?? 'recoveries')
  const [dateFrom,             setDateFrom]             = useState(c?.dateFrom ?? defFrom)
  const [dateTo,               setDateTo]               = useState(c?.dateTo   ?? defTo)
  const [includedInstitutions, setIncludedInstitutions] = useState<Set<string>>(
    new Set(c?.includedInstitutions ?? ALL_INSTITUTIONS),
  )
  const [instPanelOpen,        setInstPanelOpen]        = useState(false)
  const instDropdownRef  = useRef<HTMLDivElement>(null)
  const [rows,                 setRows]                 = useState<ReportRow[]>(c?.rows ?? [])
  const [fxRate,               setFxRate]               = useState<number>(c?.fxRate ?? 10.5)
  const [currency,             setCurrency]             = useState<'NGN' | 'KES'>('NGN')
  const [hasData,              setHasData]              = useState(!!c)
  const [loading,              setLoading]              = useState(false)
  const [error,                setError]                = useState('')
  const [execMs,               setExecMs]               = useState<number | null>(c?.execMs ?? null)
  const [activeExtra,          setActiveExtra]          = useState<Set<string>>(new Set())
  const [viewMode,             setViewMode]             = useState<'report' | 'simulator'>('report')

  // Close institution dropdown on outside click
  useEffect(() => {
    if (!instPanelOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (instDropdownRef.current && !instDropdownRef.current.contains(e.target as Node)) {
        setInstPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [instPanelOpen])

  // ── Derived ───────────────────────────────────────────────────────────────
  const visibleColumns: ColumnDef[] = [
    ...AGENT_CORE_COLUMNS,
    ...AGENT_EXTRA_COLUMNS.filter(c => activeExtra.has(c.key)),
  ]

  // Pre-convert amounts to display currency (normalized_recovery is dimensionless — no conversion)
  const displayRows = useMemo<ReportRow[]>(() => rows.map(row => ({
    ...row,
    total_amount: mode === 'normalized_recovery'
      ? parseMoney(row.total_amount)
      : toDisplayAmount(parseMoney(row.total_amount), currency, fxRate),
  })), [rows, currency, fxRate, mode])

  const topAgent   = rows.find(r => Number(r.overall_rank) === 1)
  const totalAmnt  = useMemo(() =>
    rows.reduce((s, r) => s + (mode === 'normalized_recovery'
      ? parseMoney(r.total_amount)
      : toDisplayAmount(parseMoney(r.total_amount), currency, fxRate)), 0),
    [rows, currency, fxRate, mode],
  )
  const avgConv    = useMemo(() => {
    const valid = rows.filter(r => r.conversion_rate != null)
    return valid.length ? valid.reduce((s, r) => s + parseMoney(r.conversion_rate), 0) / valid.length : 0
  }, [rows])
  const topPtp     = rows.reduce((best, r) =>
    parseMoney(r.total_ptp) > parseMoney(best?.total_ptp) ? r : best, rows[0])

  const amountChartData = useMemo(() =>
    [...rows]
      .sort((a, b) => parseMoney(b.total_amount) - parseMoney(a.total_amount))
      .map(r => ({ label: String(r.agent), value: parseMoney(r.total_amount) })),
    [rows],
  )

  const metricChartData = useMemo(() =>
    [...rows]
      .sort((a, b) => Number(a.overall_rank) - Number(b.overall_rank))
      .map(r => ({
        label:      String(r.agent),
        contacts:   parseMoney(r.contact_attainment),
        ptp:        parseMoney(r.total_ptp),
        conversion: parseMoney(r.conversion_rate),
      })),
    [rows],
  )

  // ── Run ───────────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const instList = [...includedInstitutions]
      const res = await fetch('/api/reports/agent-performance/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ mode, dateFrom, dateTo, includedInstitutions: instList }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data = await res.json()
      setRows(data.rows)
      setFxRate(data.fxRate)
      setCurrency('NGN')
      setExecMs(data.executionMs)
      setHasData(true)
      _cache = { rows: data.rows, fxRate: data.fxRate, mode, dateFrom, dateTo, includedInstitutions: instList, execMs: data.executionMs }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [mode, dateFrom, dateTo, includedInstitutions])

  // ── Reset ─────────────────────────────────────────────────────────────────
  function reset() {
    setDateFrom(defFrom)
    setDateTo(defTo)
    setIncludedInstitutions(new Set(ALL_INSTITUTIONS))
    setRows([])
    setHasData(false)
    setError('')
    setExecMs(null)
    setCurrency('NGN')
    setViewMode('report')
    _cache = null
  }

  // ── Export ────────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!hasData) return
    const cols = visibleColumns.map(c =>
      c.key === 'total_amount'
        ? { ...c, label: mode === 'normalized_recovery' ? 'Norm. Recovery' : `Amount (${currency})` }
        : c,
    )
    await downloadExcel(displayRows, cols, `agent_performance_${mode}_${dateFrom}`, 'Agent Performance')
  }

  // ── Institution multi-select helpers ─────────────────────────────────────
  const allSelected    = includedInstitutions.size === ALL_INSTITUTIONS.length
  const noneSelected   = includedInstitutions.size === 0
  function toggleInst(inst: string) {
    setIncludedInstitutions(prev => {
      const next = new Set(prev)
      next.has(inst) ? next.delete(inst) : next.add(inst)
      return next
    })
  }
  function selectAll()  { setIncludedInstitutions(new Set(ALL_INSTITUTIONS)) }
  function clearAll()   { setIncludedInstitutions(new Set()) }

  const instSummary = allSelected
    ? 'All institutions'
    : noneSelected
      ? 'None selected'
      : `${includedInstitutions.size} selected`

  return (
    <div className="flex h-screen flex-col">

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-12">

      {/* Topbar */}
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Agent Performance</h1>
          <p className="mt-0.5 text-xs text-gray-400">
            Multi-dimensional agent rankings by {mode === 'recoveries' ? 'recovery amount' : mode === 'revenue' ? 'revenue' : 'normalized recovery'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Mode toggle */}
          <div className="flex rounded-md border border-gray-200 p-0.5">
            {([
              { key: 'recoveries',          label: 'Recoveries'  },
              { key: 'revenue',             label: 'Revenue'     },
              { key: 'normalized_recovery', label: 'Normalized'  },
            ] as { key: AgentMode; label: string }[]).map(m => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={clsx(
                  'rounded px-3 py-1 text-xs font-semibold transition',
                  mode === m.key
                    ? 'bg-[#2E7D32] text-white'
                    : 'text-gray-500 hover:bg-gray-100',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-gray-200" />
          {/* Report / What-If toggle */}
          <div className="flex rounded-md border border-gray-200 p-0.5">
            {([
              { key: 'report',    label: 'Report'  },
              { key: 'simulator', label: 'What-If' },
            ] as { key: 'report' | 'simulator'; label: string }[]).map(v => (
              <button
                key={v.key}
                onClick={() => hasData && setViewMode(v.key)}
                disabled={v.key === 'simulator' && !hasData}
                title={v.key === 'simulator' && !hasData ? 'Run a report first' : undefined}
                className={clsx(
                  'rounded px-3 py-1 text-xs font-semibold transition',
                  viewMode === v.key
                    ? 'bg-[#2E7D32] text-white'
                    : 'text-gray-500 hover:bg-gray-100',
                  v.key === 'simulator' && !hasData && 'cursor-not-allowed text-gray-300 hover:bg-transparent',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-gray-200" />
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

          {/* Date range */}
          <div className="flex flex-col">
            <label className={labelCls}>Date Range</label>
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

          {/* Institution filter — only meaningful in revenue mode */}
          <div className="h-9 w-px self-end bg-gray-200" />
          <div ref={instDropdownRef} className="relative flex flex-col">
            <label className={labelCls}>Institutions</label>
            <button
              onClick={() => setInstPanelOpen(v => !v)}
              className="flex w-52 items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-700 transition hover:border-gray-300 disabled:opacity-40"
            >
              <span>{instSummary}</span>
              <span className="text-gray-400">{instPanelOpen ? '▲' : '▼'}</span>
            </button>

            {instPanelOpen && (
              <div className="absolute top-full left-0 z-20 mt-1 w-64 rounded-md border border-gray-200 bg-white shadow-lg">
                <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    {instSummary}
                  </span>
                  <div className="flex gap-2">
                    <button onClick={selectAll} className="text-[10px] font-semibold text-[#2E7D32] hover:underline">All</button>
                    <button onClick={clearAll}  className="text-[10px] font-semibold text-gray-400 hover:underline">None</button>
                  </div>
                </div>
                <div className="max-h-52 overflow-y-auto p-1">
                  {ALL_INSTITUTIONS.map(inst => (
                    <label key={inst} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={includedInstitutions.has(inst)}
                        onChange={() => toggleInst(inst)}
                        className="accent-[#2E7D32]"
                      />
                      {inst}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}

        {hasData && (
          <>
            {/* Stats bar */}
            <div className="flex flex-shrink-0 flex-wrap items-center gap-6 border-b border-gray-200 bg-white px-7 py-3">
              {[
                { label: 'Top Agent',      value: String(topAgent?.agent ?? '—') },
                { label: mode === 'normalized_recovery' ? 'Total Norm. Recovery' : 'Total Amount',
                  value: mode === 'normalized_recovery' ? totalAmnt.toFixed(2) : fmtAmount(totalAmnt, currency),
                  green: true },
                { label: 'Avg Conv. Rate', value: fmtPct(avgConv) },
                { label: 'Top PTP',        value: `${topPtp?.agent ?? '—'} · ${fmtNum(parseMoney(topPtp?.total_ptp))}` },
              ].map((item, i) => (
                <div key={item.label} className="flex items-center gap-6">
                  {i > 0 && <div className="h-8 w-px bg-gray-200" />}
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{item.label}</span>
                    <span className={clsx('text-lg font-bold tracking-tight', item.green ? 'text-[#2E7D32]' : 'text-gray-900')}>
                      {item.value}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Currency banner + toggle — hidden for normalized_recovery (dimensionless) */}
            <div className={clsx('flex flex-shrink-0 items-center justify-between border-b border-blue-100 bg-blue-50 px-7 py-2', mode === 'normalized_recovery' && 'hidden')}>
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
                    className={clsx(
                      'rounded px-3 py-0.5 text-xs font-bold transition',
                      currency === c ? 'bg-blue-600 text-white' : 'text-blue-500 hover:bg-blue-100',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {viewMode === 'report' && (
              <>
                {/* Charts */}
                <div className="grid grid-cols-1 gap-4 px-7 py-4 lg:grid-cols-2">
                <BarChart
                  data={amountChartData}
                  currency={mode === 'normalized_recovery' ? 'NGN' : currency}
                  fxRate={mode === 'normalized_recovery' ? 1 : fxRate}
                  title={mode === 'recoveries' ? 'Amount Recovered by Agent' : mode === 'revenue' ? 'Revenue by Agent' : 'Normalized Recovery by Agent'}
                  color="#2E7D32"
                  ratio={mode === 'normalized_recovery'}
                />
                <MetricChart
                  data={metricChartData}
                  title="Contacts · PTPs · Conversion (by rank)"
                />
              </div>

              {/* Optional columns toggle */}
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-y border-gray-100 bg-gray-50/60 px-7 py-2">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">
                  Extra columns
                </span>
                {AGENT_EXTRA_COLUMNS.map(col => (
                  <button
                    key={col.key}
                    onClick={() => setActiveExtra(prev => {
                      const next = new Set(prev)
                      next.has(col.key) ? next.delete(col.key) : next.add(col.key)
                      return next
                    })}
                    className={clsx(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-all',
                      activeExtra.has(col.key)
                        ? 'border-[#2E7D32] bg-[#E8F5E9] text-[#1B5E20]'
                        : 'border-gray-200 bg-white text-gray-400 hover:border-[#2E7D32] hover:text-[#2E7D32]',
                    )}
                  >
                    <span className={clsx('h-1.5 w-1.5 rounded-full', activeExtra.has(col.key) ? 'bg-[#2E7D32]' : 'bg-gray-300')} />
                    {col.label}
                  </button>
                ))}
              </div>
              </>
            )}

            {viewMode === 'simulator' && (
              <AgentScoreSimulator
                rows={rows}
                dateFrom={dateFrom}
                dateTo={dateTo}
                formatAmount={v => mode === 'normalized_recovery' ? v.toFixed(3) : fmtAmount(toDisplayAmount(v, currency, fxRate), currency)}
              />
            )}
        </>
      )}

        {hasData && viewMode === 'report' && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {visibleColumns.map(col => (
                  <th
                    key={col.key}
                    className={clsx(
                      'px-6 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-400',
                      col.type === 'currency' || col.type === 'num' ? 'text-right' : 'text-left',
                    )}
                  >
                    {col.key === 'total_amount'
                      ? mode === 'normalized_recovery' ? 'Norm. Recovery' : `Amount (${currency})`
                      : col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows
                .slice()
                .sort((a, b) => Number(a.overall_rank) - Number(b.overall_rank))
                .map((row, ri) => (
                <tr key={ri} className="border-b border-gray-100 transition-colors hover:bg-gray-50/60">
                  {visibleColumns.map(col => {
                    const raw = row[col.key]
                    let display: string

                    if (col.key === 'agent') {
                      const rank = Number(row.overall_rank)
                      display = `${MEDAL[rank] ?? ''} ${raw ?? ''}`.trim()
                    } else if (col.key === 'overall_rank') {
                      display = `#${raw ?? ''}`
                    } else if (col.key === 'total_amount' && mode === 'normalized_recovery') {
                      display = raw != null ? parseMoney(raw).toFixed(3) : '—'
                    } else if (col.type === 'currency') {
                      display = raw != null ? fmtAmount(parseMoney(raw), currency) : '—'
                    } else if (['conversion_rate', 'contact_attainment', 'ptp_rate', 'recovery_rate', 'reach_attainment'].includes(col.key)) {
                      display = fmtPct(parseMoney(raw))
                    } else if (col.key === 'weighted_score') {
                      display = raw != null ? (parseMoney(raw) * 100).toFixed(1) + '%' : '—'
                    } else if (col.type === 'num') {
                      display = raw != null ? fmtNum(parseMoney(raw)) : '—'
                    } else {
                      display = String(raw ?? '—')
                    }

                    return (
                      <td
                        key={col.key}
                        className={clsx(
                          'px-6 py-2.5 tabular-nums',
                          col.type === 'currency' || col.type === 'num'
                            ? 'text-right text-gray-700'
                            : 'text-left font-semibold text-gray-800',
                        )}
                      >
                        {display}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {!hasData && !loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200">
              <FiUsers className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-gray-500">No data loaded</p>
            <p className="text-xs">Select a date range and click Run Report</p>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-[260px] right-0 z-10 flex items-center justify-between border-t border-gray-200 bg-white px-7 py-2.5">
        <p className="text-xs text-gray-400">
          {hasData ? (
            <>
              <strong className="text-gray-900">{rows.length}</strong> agents &nbsp;·&nbsp;
              <strong className="capitalize text-gray-900">{mode}</strong> mode
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
