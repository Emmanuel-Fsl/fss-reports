'use client'

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from 'react'
import { getAuth }   from 'firebase/auth'
import { FiPlay, FiRotateCcw, FiFileText, FiDownload, FiTrendingUp, FiPhone, FiMessageSquare, FiMail, FiColumns } from 'react-icons/fi'
import { downloadExcel } from '@/lib/reports/export'
import { ALL_INSTITUTIONS } from '@/lib/reports/reports.config'

// ─── Types ────────────────────────────────────────────────────────────────────
type Row = Record<string, string | number | null>

// ─── Module-level cache ───────────────────────────────────────────────────────
interface ActivitySnapshot {
  institution: string
  bucket:      string
  dateFrom:    string
  dateTo:      string
  rows:        Row[]
  hasData:     boolean
  execMs:      number | null
}
let _activityCache: ActivitySnapshot | null = null

// ─── Constants ────────────────────────────────────────────────────────────────
const KES_INSTITUTIONS = new Set(['PEZESHA', 'NUMIDA'])

const INST_BUCKETS: Record<string, string[]> = {
  'KUDA':                ['110+', '211+'],
  'CREDIT DIRECT':       ['31-60', '61-90', '91+'],
  'GROOMING MFB':        ['31-60', '61-90', '91+'],
  'VICTORY EMPOWERMENT': ['31-60', '61-90', '91+'],
  'NUMIDA':              ['61-90', '91+'],
  'NOLT':                ['31-60', '61-90', '91-180', '181+'],
  'PEZESHA':             ['91-180', '181-360', '360+'],
}

const _now         = new Date()
const DEFAULT_FROM = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-01`
const DEFAULT_TO   = _now.toISOString().slice(0, 10)

// ─── Compare mode ─────────────────────────────────────────────────────────────
// Date and institution setup mirrors WeeklyTrendView: a Year select + Month
// Range (From/To) selects, spanning every month in between — not arbitrary picks.
const MONTH_LABELS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const COMPARE_START_YEAR = 2025
const COMPARE_YEAR_OPTIONS = Array.from(
  { length: _now.getFullYear() - COMPARE_START_YEAR + 1 },
  (_, i) => String(_now.getFullYear() - i),
)
const currentMonth = _now.getMonth() + 1

function monthRange(month: string): { from: string; to: string } {
  const [y, m]  = month.split('-').map(Number)
  const from    = `${month}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const to      = `${month}-${String(lastDay).padStart(2, '0')}`
  return { from, to: to > DEFAULT_TO ? DEFAULT_TO : to }
}
function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' })
}

// Small ▲/▼ trend indicator vs the previous period — same convention as WeeklyTrendView.
function TrendIcon({ current, prev }: { current: number; prev: number | null }) {
  if (prev === null || prev === 0) return null
  if (current > prev) return <span className="ml-1 text-[9px] font-bold text-[#2E7D32]">▲</span>
  if (current < prev) return <span className="ml-1 text-[9px] font-bold text-red-500">▼</span>
  return <span className="ml-1 text-[9px] text-gray-300">—</span>
}

type CompareFmt = 'num' | 'money' | 'pct'
type CompareMetric = { key: string; label: string; fmt: CompareFmt }
const COMPARE_SECTIONS: { title: string; metrics: CompareMetric[] }[] = [
  {
    title: 'Recovery Performance',
    metrics: [
      { key: 'total_customers',     label: 'Total Customers',     fmt: 'num'   },
      { key: 'paying_customers',    label: 'Paying Customers',    fmt: 'num'   },
      { key: 'conversion_rate',     label: 'Conversion Rate',     fmt: 'pct'   },
      { key: 'amount_recovered',    label: 'Amount Recovered',    fmt: 'money' },
      { key: 'recovery_rate',       label: 'Recovery Rate',       fmt: 'pct'   },
      { key: 'max_days_in_arrears', label: 'Max Days in Arrears', fmt: 'num'   },
    ],
  },
  {
    title: 'Phone Outreach',
    metrics: [
      { key: 'total_calls',    label: 'Total Calls',    fmt: 'num' },
      { key: 'inbound_calls',  label: 'Inbound Calls',  fmt: 'num' },
      { key: 'outbound_calls', label: 'Outbound Calls', fmt: 'num' },
      { key: 'vbs',            label: 'Voice Blasts',   fmt: 'num' },
      { key: 'vb_na',          label: 'VB Not Answered',fmt: 'num' },
      { key: 'va_bot_calls',   label: 'VA Bot Calls',   fmt: 'num' },
    ],
  },
  {
    title: 'Digital Channels (WhatsApp & SMS)',
    metrics: [
      { key: 'total_whatsapp', label: 'Total WhatsApp', fmt: 'num' },
      { key: 'agent_whatsapp', label: 'Agent WhatsApp',  fmt: 'num' },
      { key: 'bot_whatsapp',   label: 'Bot WhatsApp',    fmt: 'num' },
      { key: 'sms',            label: 'SMS Delivered',   fmt: 'num' },
      { key: 'sms_pending',    label: 'SMS Pending',     fmt: 'num' },
      { key: 'sms_failed',     label: 'SMS Failed',      fmt: 'num' },
    ],
  },
  {
    title: 'Email',
    metrics: [
      { key: 'email_success',  label: 'Email Success',        fmt: 'num' },
      { key: 'email_failed',   label: 'Email Failed',         fmt: 'num' },
      { key: 'email_inbound',  label: 'Email Inbound',        fmt: 'num' },
      { key: 'email_outbound', label: 'Agent Email Outbound', fmt: 'num' },
      { key: 'email_campaign', label: 'Email Campaign',       fmt: 'num' },
    ],
  },
]
const COMPARE_METRICS: CompareMetric[] = COMPARE_SECTIONS.flatMap(s => s.metrics)

// ─── Helpers ──────────────────────────────────────────────────────────────────
function n(v: unknown): number { return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0 }

function fmtMoney(v: number, kes = false): string {
  if (!isFinite(v)) return '—'
  return kes
    ? 'KSh ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '₦'    + v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtNum(v: number): string {
  if (!isFinite(v) || isNaN(v)) return '—'
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
function fmtPct(v: number): string {
  if (!isFinite(v) || isNaN(v)) return '—'
  return (v * 100).toFixed(1) + '%'
}

// ─── Sub-components ───────────────────────────────────────────────────────────
const inputCls = `rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px]
  text-gray-900 outline-none focus:border-[#2E7D32] focus:ring-2 focus:ring-[#2E7D32]/10 cursor-pointer`

function KpiCard({
  label, value, sub, accent, blue, pink, purple,
}: {
  label: string; value: string; sub?: string; accent?: boolean; blue?: boolean; pink?: boolean; purple?: boolean
}) {
  return (
    <div className={`flex flex-col gap-0.5 rounded-lg border px-4 py-3
      ${accent  ? 'border-green-200 bg-green-50'
      : blue    ? 'border-blue-100 bg-blue-50/40'
      : pink    ? 'border-pink-100 bg-pink-50/40'
      : purple  ? 'border-purple-100 bg-purple-50/40'
      :           'border-gray-200 bg-white'}`}>
      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</span>
      <span className={`text-lg font-bold tracking-tight
        ${accent ? 'text-green-700' : blue ? 'text-blue-700' : pink ? 'text-pink-700' : purple ? 'text-purple-700' : 'text-gray-900'}`}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-gray-400">{sub}</span>}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ActivityReportView() {
  const c = _activityCache

  const [institution, setInstitution] = useState(c?.institution ?? 'ALL')
  const [bucket,      setBucket]      = useState(c?.bucket      ?? 'ALL')
  const [dateFrom,    setDateFrom]    = useState(c?.dateFrom    ?? DEFAULT_FROM)
  const [dateTo,      setDateTo]      = useState(c?.dateTo      ?? DEFAULT_TO)
  const [rows,        setRows]        = useState<Row[]>(c?.rows        ?? [])
  const [hasData,     setHasData]     = useState(c?.hasData      ?? false)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [execMs,      setExecMs]      = useState<number | null>(c?.execMs ?? null)
  const [exporting,   setExporting]   = useState(false)
  const [channelTab,  setChannelTab]  = useState<'phone' | 'digital' | 'email'>('phone')

  // ── Compare mode ─────────────────────────────────────────────────────────
  // Year + Month Range (From/To) mirrors WeeklyTrendView; institution multi-select
  // mirrors AgentPerformanceView's checkbox dropdown (not a native <select multiple>).
  const compareMinMonth = (year: string) => (year === '2025' ? 5 : 1)
  const [compareMode,         setCompareMode]         = useState(false)
  const [compareInstitutions, setCompareInstitutions] = useState<Set<string>>(new Set())
  const [compareInstPanelOpen, setCompareInstPanelOpen] = useState(false)
  const compareInstDropdownRef = useRef<HTMLDivElement>(null)
  const [compareYear,         setCompareYear]         = useState(String(_now.getFullYear()))
  const [compareMonthFrom,    setCompareMonthFrom]    = useState(compareMinMonth(String(_now.getFullYear())))
  const [compareMonthTo,      setCompareMonthTo]      = useState(currentMonth)
  const [compareResults,      setCompareResults]      = useState<{ month: string; row: Row }[] | null>(null)
  const [compareLoading,      setCompareLoading]      = useState(false)
  const [compareError,        setCompareError]        = useState('')
  const [compareExporting,    setCompareExporting]    = useState(false)
  const compareInstList = useMemo(() => [...compareInstitutions], [compareInstitutions])
  const compareIsKes = compareInstList.length === 1 && KES_INSTITUTIONS.has(compareInstList[0])
  const compareMinMonthForYear = compareMinMonth(compareYear)

  const comparePeriods = useMemo(() => {
    const out: string[] = []
    for (let m = compareMonthFrom; m <= compareMonthTo; m++) out.push(`${compareYear}-${String(m).padStart(2, '0')}`)
    return out
  }, [compareYear, compareMonthFrom, compareMonthTo])

  // Close institution dropdown on outside click
  useEffect(() => {
    if (!compareInstPanelOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (compareInstDropdownRef.current && !compareInstDropdownRef.current.contains(e.target as Node)) {
        setCompareInstPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [compareInstPanelOpen])

  const compareNoneSelected = compareInstitutions.size === 0
  const compareAllSelected  = compareInstitutions.size === ALL_INSTITUTIONS.length
  function toggleCompareInst(inst: string) {
    setCompareInstitutions(prev => {
      const next = new Set(prev)
      next.has(inst) ? next.delete(inst) : next.add(inst)
      return next
    })
    setCompareResults(null)
  }
  function selectAllCompareInst() { setCompareInstitutions(new Set(ALL_INSTITUTIONS)); setCompareResults(null) }
  function clearCompareInst()     { setCompareInstitutions(new Set()); setCompareResults(null) }
  const compareInstSummary = compareAllSelected
    ? 'All institutions'
    : compareNoneSelected
      ? 'Select institutions'
      : compareInstList.length === 1
        ? compareInstList[0]
        : `${compareInstList.length} selected`

  function handleCompareYearChange(newYear: string) {
    setCompareYear(newYear)
    const min = compareMinMonth(newYear)
    setCompareMonthFrom(prev => Math.max(prev, min))
    setCompareMonthTo(prev => Math.max(prev, min))
    setCompareResults(null)
  }

  const runCompare = useCallback(async () => {
    if (compareInstList.length === 0 || comparePeriods.length < 2) return
    setCompareLoading(true)
    setCompareError('')
    try {
      const token   = await getAuth().currentUser?.getIdToken()
      const results = await Promise.all(comparePeriods.map(async month => {
        const { from, to } = monthRange(month)
        const res = await fetch('/api/reports/activity/run', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ institution: compareInstList, dateFrom: from, dateTo: to, bucket: 'ALL' }),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? `Query failed for ${monthLabel(month)}`)
        const data = await res.json()
        return { month, row: (data.rows?.[0] ?? {}) as Row }
      }))
      setCompareResults(results)
    } catch (err: any) {
      setCompareError(err.message)
    } finally {
      setCompareLoading(false)
    }
  }, [compareInstList, comparePeriods])

  async function handleCompareExport() {
    if (!compareResults || !compareResults.length) return
    setCompareExporting(true)
    try {
      const cols = [
        { key: 'metric', label: 'Metric', type: 'text' as const },
        ...compareResults.map(r => ({ key: r.month, label: monthLabel(r.month), type: 'text' as const })),
      ]
      const exportRows = COMPARE_METRICS.map(metric => {
        const row: Record<string, string> = { metric: metric.label }
        for (const r of compareResults) {
          const v = n(r.row[metric.key])
          row[r.month] = metric.fmt === 'money' ? fmtMoney(v, compareIsKes) : metric.fmt === 'pct' ? fmtPct(v) : fmtNum(v)
        }
        return row
      })
      const stamp    = new Date().toISOString().slice(0, 10)
      const instName = compareInstList.length === 1
        ? compareInstList[0].replace(/\s+/g, '_').toLowerCase()
        : `${compareInstList.length}_institutions`
      await downloadExcel(exportRows, cols, `activity_compare_${instName}_${stamp}`, 'Activity Compare')
    } catch (err: any) {
      setCompareError(err.message)
    } finally {
      setCompareExporting(false)
    }
  }

  const isAllMode = institution === 'ALL'
  const isKes     = KES_INSTITUTIONS.has(institution)
  const single    = !isAllMode && rows.length > 0 ? rows[0] : null

  function clearResults() {
    setRows([])
    setHasData(false)
    setError('')
    setExecMs(null)
    _activityCache = null
  }

  function handleInstitutionChange(val: string) {
    setInstitution(val)
    setBucket('ALL')
    clearResults()
  }

  function handleBucketChange(val: string) {
    setBucket(val)
    clearResults()
  }

  const allTotals = useMemo(() => {
    if (!isAllMode || !rows.length) return null
    const totalCustomers  = rows.reduce((s, r) => s + n(r.total_customers), 0)
    const payingCustomers = rows.reduce((s, r) => s + n(r.paying_customers), 0)
    const totalCalls      = rows.reduce((s, r) => s + n(r.total_calls), 0)
    const totalWhatsapp   = rows.reduce((s, r) => s + n(r.total_whatsapp), 0)
    const totalSms        = rows.reduce((s, r) => s + n(r.sms), 0)
    const conversionRate  = totalCustomers > 0 ? payingCustomers / totalCustomers : 0
    return { totalCustomers, payingCustomers, conversionRate, totalCalls, totalWhatsapp, totalSms }
  }, [rows, isAllMode])

  // ── Run ────────────────────────────────────────────────────────────────────
  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAuth().currentUser?.getIdToken()
      const res = await fetch('/api/reports/activity/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ institution, dateFrom, dateTo, bucket }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Query failed')
      const data    = await res.json()
      const newRows = data.rows ?? []
      setRows(newRows)
      setExecMs(data.executionMs)
      setHasData(true)
      _activityCache = {
        institution, bucket, dateFrom, dateTo,
        rows: newRows, hasData: true, execMs: data.executionMs,
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [institution, bucket, dateFrom, dateTo])

  // ── Export ─────────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!hasData || !rows.length) return
    setExporting(true)
    try {
      const baseMetricCols: { key: string; label: string; type: 'text' | 'currency' }[] = [
        { key: 'total_customers',    label: 'Total Customers',    type: 'text'     },
        { key: 'paying_customers',   label: 'Paying Customers',   type: 'text'     },
        { key: 'conversion_rate',    label: 'Conversion Rate',    type: 'text'     },
        { key: 'amount_recovered',   label: 'Amount Recovered',   type: 'currency' },
        { key: 'recovery_rate',      label: 'Recovery Rate',      type: 'text'     },
        { key: 'max_days_in_arrears',label: 'Max Days in Arrears',type: 'text'     },
        { key: 'total_calls',        label: 'Total Calls',        type: 'text'     },
        { key: 'inbound_calls',      label: 'Inbound Calls',      type: 'text'     },
        { key: 'outbound_calls',     label: 'Outbound Calls',     type: 'text'     },
        { key: 'vbs',                label: 'Voice Blasts',       type: 'text'     },
        { key: 'va_bot_calls',       label: 'VA Bot Calls',       type: 'text'     },
        { key: 'total_whatsapp',       label: 'Total WhatsApp',        type: 'text' },
        { key: 'agent_whatsapp',      label: 'Agent WhatsApp',        type: 'text' },
        { key: 'bot_whatsapp',        label: 'Bot WhatsApp',          type: 'text' },
        { key: 'sms',                 label: 'SMS Delivered',         type: 'text' },
        { key: 'sms_pending',         label: 'SMS Pending',           type: 'text' },
        { key: 'sms_failed',          label: 'SMS Failed',            type: 'text' },
        { key: 'vb_na',               label: 'VB Not Answered',       type: 'text' },
        { key: 'email_success',  label: 'Email All Success', type: 'text' },
        { key: 'email_failed',   label: 'Email Failed',      type: 'text' },
        { key: 'email_inbound',  label: 'Email Inbound',     type: 'text' },
        { key: 'email_outbound', label: 'Agent Email Outbound', type: 'text' },
        { key: 'email_campaign', label: 'Email Campaign',    type: 'text' },
      ]
      const cols = isAllMode
        ? [{ key: 'institution', label: 'Institution', type: 'text' as const }, ...baseMetricCols]
        : baseMetricCols

      const exportRows = rows.map(r => ({
        ...r,
        conversion_rate: fmtPct(n(r.conversion_rate)),
        recovery_rate:   fmtPct(n(r.recovery_rate)),
      }))

      const stamp = new Date().toISOString().slice(0, 10)
      const name  = isAllMode
        ? `activity_all_${stamp}`
        : `activity_${institution.replace(/\s+/g, '_').toLowerCase()}_${stamp}`
      await downloadExcel(exportRows, cols, name, 'Activity Report')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  function reset() {
    setRows([])
    setHasData(false)
    setError('')
    setExecMs(null)
    setInstitution('ALL')
    setBucket('ALL')
    setDateFrom(DEFAULT_FROM)
    setDateTo(DEFAULT_TO)
    _activityCache = null
    setCompareInstitutions(new Set())
    setCompareYear(String(_now.getFullYear()))
    setCompareMonthFrom(compareMinMonth(String(_now.getFullYear())))
    setCompareMonthTo(currentMonth)
    setCompareResults(null)
    setCompareError('')
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-14">

        {/* Topbar */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-7 py-3.5">
          <div>
            <h1 className="text-[17px] font-bold tracking-tight text-gray-900">Activity Report</h1>
            <p className="mt-0.5 text-xs text-gray-400">
              {compareMode
                ? 'Compare recovery performance and activity across two or more months'
                : 'Recovery performance and contact channel activity by institution'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="mr-2 flex items-center gap-0.5 rounded-md border border-gray-200 bg-gray-50 p-0.5">
              <button
                onClick={() => setCompareMode(false)}
                className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide transition
                  ${!compareMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                Single
              </button>
              <button
                onClick={() => setCompareMode(true)}
                className={`flex items-center gap-1 rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide transition
                  ${compareMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <FiColumns className="h-3 w-3" /> Compare
              </button>
            </div>
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-semibold text-gray-400 transition hover:bg-gray-100"
            >
              <FiRotateCcw className="h-3 w-3" /> Reset
            </button>
            <button
              onClick={compareMode ? runCompare : runReport}
              disabled={compareMode ? (compareLoading || compareInstList.length === 0 || comparePeriods.length < 2) : loading}
              className="flex items-center gap-1.5 rounded-md bg-[#2E7D32] px-4 py-1.5 text-xs font-bold text-white transition hover:bg-[#1B5E20] disabled:opacity-60"
            >
              {(compareMode ? compareLoading : loading)
                ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                : <FiPlay className="h-3 w-3" />}
              {compareMode ? 'Run Comparison' : 'Run Report'}
            </button>
          </div>
        </div>

        {/* Filters */}
        {!compareMode ? (
          <div className="flex-shrink-0 border-b border-gray-200 bg-white px-7 py-4">
            <div className="flex items-end gap-6">

              {/* Institution */}
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Institution</label>
                <select
                  value={institution}
                  onChange={e => handleInstitutionChange(e.target.value)}
                  className={`w-52 ${inputCls}`}
                >
                  <option value="ALL">All Institutions</option>
                  {ALL_INSTITUTIONS.map(inst => (
                    <option key={inst} value={inst}>{inst}</option>
                  ))}
                </select>
              </div>

              {!isAllMode && (INST_BUCKETS[institution]?.length ?? 0) > 0 && (
                <>
                  <div className="h-9 w-px self-end bg-gray-200" />

                  {/* Arrears bucket — single institution only */}
                  <div className="flex flex-col">
                    <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Arrears Bucket</label>
                    <select
                      value={bucket}
                      onChange={e => handleBucketChange(e.target.value)}
                      className={`w-36 ${inputCls}`}
                    >
                      <option value="ALL">All Buckets</option>
                      {(INST_BUCKETS[institution] ?? []).map(b => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="h-9 w-px self-end bg-gray-200" />

              {/* Date range */}
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
            </div>
          </div>
        ) : (
          <div className="flex-shrink-0 border-b border-gray-200 bg-white px-7 py-4">
            <div className="flex items-end gap-6">

              {/* Institutions — checkbox dropdown, summed when 2+ chosen (same pattern as Agent Performance) */}
              <div ref={compareInstDropdownRef} className="relative flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Institutions{compareInstList.length > 1 && <span className="normal-case text-gray-300"> · summed</span>}
                </label>
                <button
                  type="button"
                  onClick={() => setCompareInstPanelOpen(v => !v)}
                  className="flex w-52 items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-700 transition hover:border-gray-300"
                >
                  <span>{compareInstSummary}</span>
                  <span className="text-gray-400">{compareInstPanelOpen ? '▲' : '▼'}</span>
                </button>

                {compareInstPanelOpen && (
                  <div className="absolute top-full left-0 z-20 mt-1 w-64 rounded-md border border-gray-200 bg-white shadow-lg">
                    <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                        {compareInstSummary}
                      </span>
                      <div className="flex gap-2">
                        <button onClick={selectAllCompareInst} className="text-[10px] font-semibold text-[#2E7D32] hover:underline">All</button>
                        <button onClick={clearCompareInst}     className="text-[10px] font-semibold text-gray-400 hover:underline">None</button>
                      </div>
                    </div>
                    <div className="max-h-52 overflow-y-auto p-1">
                      {ALL_INSTITUTIONS.map(inst => (
                        <label key={inst} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={compareInstitutions.has(inst)}
                            onChange={() => toggleCompareInst(inst)}
                            className="accent-[#2E7D32]"
                          />
                          {inst}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="h-9 w-px self-end bg-gray-200" />

              <div className="flex w-28 flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Year</label>
                <select value={compareYear} onChange={e => handleCompareYearChange(e.target.value)} className={inputCls}>
                  {COMPARE_YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>

              <div className="h-9 w-px self-end bg-gray-200" />

              {/* Month Range — every month from → to is compared */}
              <div className="flex flex-col">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Month Range{comparePeriods.length > 0 && <span className="normal-case text-gray-300"> · {comparePeriods.length} months (min 2)</span>}
                </label>
                <div className="flex items-end gap-3">
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">From</span>
                    <select
                      value={compareMonthFrom}
                      onChange={e => setCompareMonthFrom(Number(e.target.value))}
                      className="w-28 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer"
                    >
                      {MONTH_LABELS.filter((_, i) => i + 1 >= compareMinMonthForYear).map(m => (
                        <option key={m} value={MONTH_LABELS.indexOf(m) + 1}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <span className="mb-2 select-none text-sm text-gray-300">→</span>
                  <div className="flex flex-col">
                    <span className="mb-1 text-[10px] text-gray-400">To</span>
                    <select
                      value={compareMonthTo}
                      onChange={e => setCompareMonthTo(Number(e.target.value))}
                      className="w-28 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-[#2E7D32] cursor-pointer"
                    >
                      {MONTH_LABELS.filter((_, i) => i + 1 >= Math.max(compareMonthFrom, compareMinMonthForYear)).map(m => (
                        <option key={m} value={MONTH_LABELS.indexOf(m) + 1}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {!compareMode && error && (
          <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">{error}</div>
        )}
        {compareMode && compareError && (
          <div className="flex-shrink-0 bg-red-50 px-7 py-3 text-xs font-semibold text-red-600">{compareError}</div>
        )}

        {!compareMode && hasData && (
          <>
            {/* ── All Institutions mode ─────────────────────────────────── */}
            {isAllMode && allTotals && (
              <>
                <div className="grid grid-cols-6 gap-3 border-b border-gray-100 px-7 py-4">
                  <KpiCard label="Total Customers"  value={fmtNum(allTotals.totalCustomers)}
                    sub="across all institutions" />
                  <KpiCard label="Paying Customers" value={fmtNum(allTotals.payingCustomers)}
                    sub="any payment in period" accent />
                  <KpiCard label="Conversion Rate"  value={fmtPct(allTotals.conversionRate)}
                    sub="paying / total" />
                  <KpiCard label="Total Calls"      value={fmtNum(allTotals.totalCalls)}
                    sub="all call types combined" blue />
                  <KpiCard label="Total WhatsApp"   value={fmtNum(allTotals.totalWhatsapp)}
                    sub="agent + bot" blue />
                  <KpiCard label="SMS Delivered"    value={fmtNum(allTotals.totalSms)}
                    sub="successful deliveries" blue />
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        {[
                          'Institution', 'Customers', 'Paying', 'Conv. %', 'Recov. %',
                          'Amount Recovered', 'Max DIA',
                          'Total Calls', 'Inbound', 'Outbound', 'VBs', 'VB N/A', 'VA Bot',
                          'WhatsApp', 'Agent WA', 'Bot WA',
                          'SMS', 'SMS Pending', 'SMS Failed',
                          'Email ✓', 'Email ✗', 'Email In', 'Agent Email Out', 'Email Camp.',
                        ].map(h => (
                          <th key={h} className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const inst = String(row.institution ?? '')
                        const kes  = KES_INSTITUTIONS.has(inst)
                        return (
                          <tr key={i} className="whitespace-nowrap border-b border-gray-100 hover:bg-gray-50/60">
                            <td className="px-4 py-2 font-semibold text-gray-800">{inst || '—'}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{fmtNum(n(row.total_customers))}</td>
                            <td className="px-4 py-2 text-right font-semibold text-green-700">{fmtNum(n(row.paying_customers))}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{fmtPct(n(row.conversion_rate))}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{fmtPct(n(row.recovery_rate))}</td>
                            <td className="px-4 py-2 text-right font-sans font-semibold text-gray-900">{fmtMoney(n(row.amount_recovered), kes)}</td>
                            <td className="px-4 py-2 text-right font-mono text-[11px] text-gray-500">{fmtNum(n(row.max_days_in_arrears))}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{fmtNum(n(row.total_calls))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.inbound_calls))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.outbound_calls))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.vbs))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.vb_na))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.va_bot_calls))}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{fmtNum(n(row.total_whatsapp))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.agent_whatsapp))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.bot_whatsapp))}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{fmtNum(n(row.sms))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.sms_pending))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.sms_failed))}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{fmtNum(n(row.email_success))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.email_failed))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.email_inbound))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.email_outbound))}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{fmtNum(n(row.email_campaign))}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ── Single institution mode ───────────────────────────────── */}
            {!isAllMode && single && (
              <>
                <div className="border-b border-gray-100 px-7 py-4">
                  <p className="mb-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400"><FiTrendingUp className="h-3 w-3" /> Recovery Performance</p>
                  <div className="grid grid-cols-6 gap-3">
                    <KpiCard label="Total Customers"     value={fmtNum(n(single.total_customers))}
                      sub="in portfolio for period" />
                    <KpiCard label="Paying Customers"    value={fmtNum(n(single.paying_customers))}
                      sub={`${fmtPct(n(single.conversion_rate))} conversion`} accent />
                    <KpiCard label="Conversion Rate"     value={fmtPct(n(single.conversion_rate))}
                      sub="paying / total customers" />
                    <KpiCard label="Recovery Rate"       value={fmtPct(n(single.recovery_rate))}
                      sub="recovered / assigned" />
                    <KpiCard label="Amount Recovered"    value={fmtMoney(n(single.amount_recovered), isKes)}
                      sub="total collected" accent />
                    <KpiCard label="Max Days in Arrears" value={fmtNum(n(single.max_days_in_arrears))}
                      sub="highest in result set" />
                  </div>
                </div>

                {/* ── Contact Channels (tabbed) ──────────────────────── */}
                <div className="border-b border-gray-100 px-7 py-4">
                  {/* Tab bar */}
                  <div className="mb-4 flex items-center gap-1 border-b border-gray-100 pb-0">
                    {([
                      { key: 'phone',   label: 'Phone Outreach',   icon: <FiPhone className="h-3 w-3" /> },
                      { key: 'digital', label: 'Digital Channels', icon: <FiMessageSquare className="h-3 w-3" /> },
                      { key: 'email',   label: 'Email',            icon: <FiMail className="h-3 w-3" /> },
                    ] as const).map(tab => (
                      <button
                        key={tab.key}
                        onClick={() => setChannelTab(tab.key)}
                        className={`flex items-center gap-1.5 rounded-t px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition
                          ${channelTab === tab.key
                            ? 'border-b-2 border-[#2E7D32] text-[#2E7D32]'
                            : 'text-gray-400 hover:text-gray-600'}`}
                      >
                        {tab.icon}{tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Phone */}
                  {channelTab === 'phone' && (
                    <div className="grid grid-cols-6 gap-3">
                      <KpiCard label="Total Calls"     value={fmtNum(n(single.total_calls))}    blue />
                      <KpiCard label="Inbound Calls"   value={fmtNum(n(single.inbound_calls))}  sub="agent received" blue />
                      <KpiCard label="Outbound Calls"  value={fmtNum(n(single.outbound_calls))} sub="agent dialled" blue />
                      <KpiCard label="Voice Blasts"    value={fmtNum(n(single.vbs))}            sub="automated VB" blue />
                      <KpiCard label="VB Not Answered" value={fmtNum(n(single.vb_na))}          sub="unanswered VBs" blue />
                      <KpiCard label="VA Bot Calls"    value={fmtNum(n(single.va_bot_calls))}   sub="virtual assistant" blue />
                    </div>
                  )}

                  {/* Digital */}
                  {channelTab === 'digital' && (
                    <div className="grid grid-cols-6 gap-3">
                      <KpiCard label="Total WhatsApp"  value={fmtNum(n(single.total_whatsapp))}  blue />
                      <KpiCard label="Agent WhatsApp"  value={fmtNum(n(single.agent_whatsapp))}  sub="agent-sent messages" blue />
                      <KpiCard label="Bot WhatsApp"    value={fmtNum(n(single.bot_whatsapp))}    sub="automated messages" blue />
                      <KpiCard label="SMS Delivered"   value={fmtNum(n(single.sms))}             sub="successful deliveries" blue />
                      <KpiCard label="SMS Pending"     value={fmtNum(n(single.sms_pending))}     sub="awaiting delivery" blue />
                      <KpiCard label="SMS Failed"      value={fmtNum(n(single.sms_failed))}      sub="delivery failed" blue />
                    </div>
                  )}

                  {/* Email */}
                  {channelTab === 'email' && (
                    <div className="grid grid-cols-5 gap-3">
                      <KpiCard label="All Successful"  value={fmtNum(n(single.email_success))}   sub="total emails sent" blue />
                      <KpiCard label="Inbound"         value={fmtNum(n(single.email_inbound))}   sub="incoming" blue />
                      <KpiCard label="Agent Outbound"  value={fmtNum(n(single.email_outbound))}  sub="outbound sent" blue />
                      <KpiCard label="Campaign"        value={fmtNum(n(single.email_campaign))}  sub="targeted campaigns" blue />
                      <KpiCard label="Email Failed"    value={fmtNum(n(single.email_failed))}    sub="all delivery failures" blue />
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {!compareMode && !hasData && !loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200">
              <FiFileText className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-gray-500">No data loaded</p>
            <p className="text-xs">Select an institution and date range, then click Run Report</p>
          </div>
        )}

        {!compareMode && loading && (
          <div className="flex items-center justify-center gap-3 py-24 text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-[#2E7D32]" />
            <span className="text-sm">Running query…</span>
          </div>
        )}

        {/* ── Compare mode results ────────────────────────────────────────── */}
        {compareMode && compareResults && compareResults.length > 0 && (
          <div className="overflow-x-auto px-7 py-4">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">Metric</th>
                  {compareResults.map((r, i) => (
                    <th key={r.month} className="whitespace-nowrap px-4 py-2.5 text-right text-[10px] font-bold uppercase tracking-wider text-gray-400">
                      {monthLabel(r.month)}
                      {i > 0 && <span className="ml-1 font-normal normal-case text-gray-300">vs {monthLabel(compareResults[i - 1].month)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_SECTIONS.map(section => (
                  <Fragment key={section.title}>
                    <tr>
                      <td colSpan={compareResults.length + 1} className="border-b border-gray-100 bg-gray-50/60 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                        {section.title}
                      </td>
                    </tr>
                    {section.metrics.map(metric => {
                      const values = compareResults.map(r => n(r.row[metric.key]))
                      const fmt    = (v: number) =>
                        metric.fmt === 'money' ? fmtMoney(v, compareIsKes) : metric.fmt === 'pct' ? fmtPct(v) : fmtNum(v)
                      return (
                        <tr key={metric.key} className="whitespace-nowrap border-b border-gray-100 hover:bg-gray-50/60">
                          <td className="px-4 py-2 font-semibold text-gray-800">{metric.label}</td>
                          {values.map((v, i) => (
                            <td key={i} className="px-4 py-2 text-right text-gray-700">
                              {fmt(v)}
                              {i > 0 && <TrendIcon current={v} prev={values[i - 1]} />}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {compareMode && !compareResults && !compareLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-gray-200">
              <FiColumns className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-gray-500">No comparison run yet</p>
            <p className="text-xs">Select one or more institutions and 2+ months, then click Run Comparison</p>
          </div>
        )}

        {compareMode && compareLoading && (
          <div className="flex items-center justify-center gap-3 py-24 text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-[#2E7D32]" />
            <span className="text-sm">Running {comparePeriods.length} queries…</span>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-[260px] right-0 z-10 flex items-center justify-between border-t border-gray-200 bg-white px-7 py-2.5">
        <p className="text-xs text-gray-400">
          {compareMode ? (
            compareResults ? (
              <>
                <strong className="text-gray-900">{compareResults.length}</strong> month{compareResults.length !== 1 ? 's' : ''}
                &nbsp;·&nbsp; <strong className="text-gray-900">{compareInstList.length}</strong> institution{compareInstList.length !== 1 ? 's' : ''}
                {compareInstList.length > 1 && <> &nbsp;·&nbsp; <span className="text-gray-500">summed{compareIsKes ? '' : ', NGN'}</span></>}
              </>
            ) : '—'
          ) : hasData ? (
            <>
              {isAllMode
                ? <><strong className="text-gray-900">{rows.length}</strong> institution{rows.length !== 1 ? 's' : ''}</>
                : <><strong className="text-gray-900">{fmtNum(n(single?.total_customers))}</strong> customers</>}
              {execMs != null && <> &nbsp;·&nbsp; <span className="font-mono">{execMs}ms</span></>}
              {!isAllMode && single && (
                <> &nbsp;·&nbsp; <span className="font-semibold text-green-700">{fmtMoney(n(single.amount_recovered), isKes)}</span> recovered &nbsp;·&nbsp; <span className="text-gray-600">{fmtPct(n(single.conversion_rate))}</span> conversion</>
              )}
              {bucket !== 'ALL' && <> &nbsp;·&nbsp; <span className="text-gray-500">{bucket} bucket</span></>}
            </>
          ) : '—'}
        </p>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-300">Export as</span>
          <button
            onClick={compareMode ? handleCompareExport : handleExport}
            disabled={compareMode ? (!compareResults || compareExporting) : (!hasData || exporting)}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {(compareMode ? compareExporting : exporting)
              ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
              : <FiDownload className="h-3 w-3" />}
            EXCEL
          </button>
        </div>
      </div>
    </div>
  )
}
