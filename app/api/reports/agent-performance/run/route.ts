import { NextRequest, NextResponse }  from 'next/server'
import { verifyToken }                from '@/lib/firebase/admin'
import { runBQQuery }                 from '@/lib/bq/client'
import {
  buildRecoveriesQuery,
  buildRevenueQuery,
  buildNormalizedRecoveryQuery,
  buildFxRateQuery,
}                                     from '@/lib/reports/agent-performance.queries'
import type { ReportRow }             from '@/types'

function normalizeValue(value: unknown): string | number | null {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.value === 'string' || typeof v.value === 'number') return v.value
    if (typeof (value as { toISOString?: () => string }).toISOString === 'function')
      return (value as { toISOString: () => string }).toISOString().slice(0, 10)
    return JSON.stringify(value)
  }
  return String(value)
}

function normalizeRows(rows: unknown[]): ReportRow[] {
  return rows.map(row => {
    const obj = row as Record<string, unknown>
    const out: ReportRow = {}
    for (const [k, v] of Object.entries(obj)) out[k] = normalizeValue(v)
    return out
  })
}

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const { mode, dateFrom, dateTo, includedInstitutions } = await req.json()
    const start = Date.now()

    const sql = mode === 'revenue'
      ? buildRevenueQuery({ dateFrom, dateTo, includedInstitutions })
      : mode === 'normalized_recovery'
        ? buildNormalizedRecoveryQuery({ dateFrom, dateTo, includedInstitutions })
        : buildRecoveriesQuery({ dateFrom, dateTo, includedInstitutions })

    const [[rawRows], [fxRows]] = await Promise.all([
      runBQQuery(sql),
      runBQQuery(buildFxRateQuery()),
    ])

    const rows   = normalizeRows(rawRows as unknown[])
    // ngn_per_unit: 1 KES = ngn_per_unit NGN  (e.g. 10.5 means 1 KES = ₦10.50)
    // Both query modes return total_amount already in NGN — the BQ query handles conversion.
    // fxRate is passed to the frontend so it can optionally display amounts in KES (÷ fxRate).
    const fxRate = Number((fxRows as Record<string, unknown>[])[0]?.ngn_per_unit ?? 10.5)

    return NextResponse.json({ rows, fxRate, executionMs: Date.now() - start })
  } catch (err: any) {
    console.error('[agent-performance/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
