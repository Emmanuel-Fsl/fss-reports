'use client'

import Link from 'next/link'
import { FiTrendingUp } from 'react-icons/fi'
import { trendCache } from '@/lib/reports/trend-cache'

const MONTH_KEYS   = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function parseMoney(v: unknown): number {
  if (v == null || v === '') return 0
  return parseFloat(String(v).replace(/,/g, '')) || 0
}

function fmtShort(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K'
  return String(Math.round(n))
}

export default function TrendMiniChart() {
  const c = trendCache

  if (!c || !c.rows.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-gray-200 text-gray-300">
          <FiTrendingUp className="h-5 w-5" />
        </div>
        <p className="text-sm font-semibold text-gray-500">Weekly Trend</p>
        <p className="text-xs text-gray-400">Run the Weekly Trend report to see a chart here</p>
        <Link
          href="/reports/weekly_trend_report"
          className="mt-1 rounded-md bg-[#2E7D32] px-4 py-1.5 text-xs font-bold text-white hover:bg-[#1B5E20]"
        >
          Run Report
        </Link>
      </div>
    )
  }

  // Build monthly totals
  const months = MONTH_KEYS
    .map((key, i) => ({ key, label: MONTH_LABELS[i], num: i + 1 }))
    .filter(m => m.num >= c.monthFrom && m.num <= c.monthTo)

  const totals = months.map(m => ({
    label: m.label,
    value: c.rows.reduce((s, r) => s + parseMoney(r[m.key]), 0),
  }))

  // SVG layout
  const W = 400, H = 120
  const PAD = { left: 38, right: 12, top: 14, bottom: 26 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const maxVal = Math.max(...totals.map(t => t.value), 1)

  const pts = totals.map((t, i) => ({
    x: PAD.left + (totals.length === 1 ? plotW / 2 : (i / (totals.length - 1)) * plotW),
    y: PAD.top + plotH - (t.value / maxVal) * plotH,
    ...t,
  }))

  const polyline = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const areaPath = [
    `${pts[0].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}`,
    polyline,
    `${pts[pts.length - 1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}`,
  ].join(' ')

  const grandTotal = totals.reduce((s, t) => s + t.value, 0)

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Weekly Trend</p>
          <p className="mt-0.5 text-[13px] font-bold text-gray-900">
            ₦{fmtShort(grandTotal)}
            <span className="ml-1.5 text-xs font-normal text-gray-400">total</span>
          </p>
          <p className="text-[11px] text-gray-400">
            {c.year} · {c.institution || 'All Institutions'}
          </p>
        </div>
        <Link
          href="/reports/weekly_trend_report"
          className="text-[11px] font-semibold text-[#2E7D32] hover:underline"
        >
          View →
        </Link>
      </div>

      {/* Chart */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {/* Gridlines + y-labels */}
        {[0, 0.5, 1].map(frac => {
          const y = PAD.top + plotH - frac * plotH
          return (
            <g key={frac}>
              <line
                x1={PAD.left} x2={W - PAD.right}
                y1={y} y2={y}
                stroke="#F3F4F6" strokeWidth="1"
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize="8" fill="#9CA3AF">
                {fmtShort(frac * maxVal)}
              </text>
            </g>
          )
        })}

        {/* Area fill */}
        <polygon points={areaPath} fill="#2E7D32" fillOpacity="0.07" />

        {/* Line */}
        <polyline
          points={polyline}
          fill="none"
          stroke="#2E7D32"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Dots + x-labels */}
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="3" fill="#2E7D32" />
            <text x={p.x} y={H - 4} textAnchor="middle" fontSize="9" fill="#6B7280">
              {p.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
