import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runBQQuery }                from '@/lib/bq/client'
import { ALL_INSTITUTIONS }          from '@/lib/reports/reports.config'
import {
  buildBillingSummaryQuery,
  buildBillingDetailQuery,
} from '@/lib/reports/billing.queries'
import { buildFxRateQuery }          from '@/lib/reports/agent-performance.queries'
import type { ReportFilters, ReportRow } from '@/types'

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

    const { institution, dateFrom, dateTo, institutionDates, groomingMfiSegment }: ReportFilters = await req.json()
    const start = Date.now()
    const df    = dateFrom ?? '2026-04-01'
    const dt    = dateTo   ?? '2026-04-30'

    const isSingleInst    = !!(institution?.trim())
    const hasCustomDates  = !isSingleInst && !!institutionDates && Object.keys(institutionDates).length > 0

    // ── Summary ──────────────────────────────────────────────────────────────
    let summaryRows: ReportRow[]

    if (hasCustomDates) {
      // Run one summary query per institution using its specific date range,
      // then combine. Institutions with no deposits return 0 rows → excluded.
      const results = await Promise.all(
        ALL_INSTITUTIONS.map(async inst => {
          const dates = institutionDates![inst] ?? { dateFrom: df, dateTo: dt }
          const sql   = buildBillingSummaryQuery({
            institution: inst,
            dateFrom:    dates.dateFrom,
            dateTo:      dates.dateTo,
          })
          const [raw] = await runBQQuery(sql)
          return normalizeRows(raw as unknown[])
        }),
      )
      summaryRows = results.flat()
    } else {
      const summarySql    = buildBillingSummaryQuery({ institution, dateFrom, dateTo, groomingMfiSegment })
      const [summaryRaw]  = await runBQQuery(summarySql)
      summaryRows         = normalizeRows(summaryRaw as unknown[])
    }

    // ── Detail (only for single institution) ─────────────────────────────────
    let detailRows: ReportRow[] | null = null
    if (isSingleInst) {
      const detailSql = buildBillingDetailQuery(
        institution!.trim(),
        df,
        dt,
        groomingMfiSegment,
      )
      const [detailRaw] = await runBQQuery(detailSql)
      detailRows = normalizeRows(detailRaw as unknown[])
    }

    const [fxRows] = await runBQQuery(buildFxRateQuery())
    const fxRate   = Number((fxRows as Record<string, unknown>[])[0]?.ngn_per_unit ?? 10.5)

    return NextResponse.json({
      summaryRows,
      detailRows,
      fxRate,
      rowCount:    summaryRows.length,
      executionMs: Date.now() - start,
    })
  } catch (err: any) {
    console.error('[billing/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}