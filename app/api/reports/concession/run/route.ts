import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runBQQuery }                from '@/lib/bq/client'
import { buildConcessionQuery, getSnapshotDate } from '@/lib/reports/concession.queries'

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

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const { institution, dateFrom, dateTo } = await req.json()
    if (!institution) return NextResponse.json({ error: 'institution is required' }, { status: 400 })

    const df    = dateFrom ?? '2026-04-25'
    const dt    = dateTo   ?? new Date().toISOString().slice(0, 10)
    const start = Date.now()

    // For KUDA past months: confirm the snapshot date exists before using it.
    // If the end-of-month snapshot hasn't been written yet, fall back to live table.
    let resolvedSnapshot: string | null | undefined
    if (institution === 'KUDA') {
      const desired = getSnapshotDate(df)
      if (desired !== null) {
        const [checkRaw] = await runBQQuery(
          `SELECT COUNT(*) > 0 AS has_snapshot FROM \`fssspark.recovery_methods_data.timestamp_balances\` WHERE date_stored = '${desired}'`
        )
        const has = (checkRaw as Record<string, unknown>[])[0]?.has_snapshot
        resolvedSnapshot = has === true ? desired : null
      }
    }

    const sql = buildConcessionQuery(institution, df, dt, resolvedSnapshot)
    const [raw] = await runBQQuery(sql)

    const rows = (raw as Record<string, unknown>[]).map(row => {
      const out: Record<string, string | number | null> = {}
      for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v)
      return out
    })

    return NextResponse.json({ rows, rowCount: rows.length, executionMs: Date.now() - start })
  } catch (err: any) {
    console.error('[concession/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
