import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runBQQuery }                from '@/lib/bq/client'
import { ALL_INSTITUTIONS }          from '@/lib/reports/reports.config'
import {
  buildBillingSummaryQuery,
  buildBillingDetailQuery,
} from '@/lib/reports/billing.queries'
import {
  getBillingDetailColumns,
  ALL_BILLING_SUMMARY_COLUMNS,
} from '@/lib/reports/billing'
import type { ReportRow, ColumnDef } from '@/types'

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

export interface BillingDetailSheet {
  institution: string
  rows:        ReportRow[]
  cols:        ColumnDef[]
}

export interface BillingExportPayload {
  institution?:     string
  dateFrom?:        string
  dateTo?:          string
  institutionDates?: Record<string, { dateFrom: string; dateTo: string }>
}

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const { institution, dateFrom, dateTo, institutionDates, groomingMfiSegment } = await req.json() as BillingExportPayload & { groomingMfiSegment?: 'all' | '90+' | '360+' }
    const df           = dateFrom ?? '2026-04-01'
    const dt           = dateTo   ?? '2026-04-30'
    const isSingleInst = !!(institution?.trim())
    const hasCustomDates = !isSingleInst && !!institutionDates && Object.keys(institutionDates).length > 0
    // ── Summary ───────────────────────────────────────────────────────────────
    let summaryRows: ReportRow[]

    if (hasCustomDates) {
      // One summary query per institution using its specific date range.
      // Institutions with no deposits return 0 rows → excluded.
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
      const summarySql    = buildBillingSummaryQuery({ institution, dateFrom, dateTo })
      const [summaryRaw]  = await runBQQuery(summarySql)
      summaryRows         = normalizeRows(summaryRaw as unknown[])
    }

    // ── Detail sheets ─────────────────────────────────────────────────────────
    // If single institution — one detail sheet.
    // If all institutions — one detail sheet per institution (parallel queries).
    const institutionsToFetch: string[] = isSingleInst
      ? [institution!.trim()]
      : [...ALL_INSTITUTIONS]

    const detailResults = await Promise.all(
      institutionsToFetch.map(async (inst): Promise<BillingDetailSheet | null> => {
        try {
          // Use per-institution date override if available, else fall back to global.
          const dates = hasCustomDates
            ? (institutionDates![inst] ?? { dateFrom: df, dateTo: dt })
            : { dateFrom: df, dateTo: dt }

          const sql        = buildBillingDetailQuery(inst, dates.dateFrom, dates.dateTo, inst === 'GROOMING MFI' ? groomingMfiSegment : undefined)
          const [raw]      = await runBQQuery(sql)
          const rows       = normalizeRows(raw as unknown[])
          if (rows.length === 0) return null   // skip empty — no deposits for this period
          return { institution: inst, rows, cols: getBillingDetailColumns(inst) }
        } catch {
          return null // if a query fails for one institution, skip it
        }
      }),
    )

    const details = detailResults.filter((d): d is BillingDetailSheet => d !== null)

    return NextResponse.json({
      summary: { rows: summaryRows, cols: ALL_BILLING_SUMMARY_COLUMNS },
      details,
      isEmpty: summaryRows.length === 0 && details.length === 0,
    })
  } catch (err: any) {
    console.error('[billing/export]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
