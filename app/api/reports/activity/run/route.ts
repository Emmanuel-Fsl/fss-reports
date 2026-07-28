import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runBQQuery }                from '@/lib/bq/client'
import { buildActivityQuery }        from '@/lib/reports/activity.queries'

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

    const { institution, dateFrom, dateTo, bucket } = await req.json()
    if (!institution || (Array.isArray(institution) && institution.length === 0)) {
      return NextResponse.json({ error: 'institution is required' }, { status: 400 })
    }

    const df    = dateFrom ?? '2026-06-01'
    const dt    = dateTo   ?? new Date().toISOString().slice(0, 10)
    const start = Date.now()

    const sql = buildActivityQuery(institution, df, dt, bucket ?? 'ALL')
    const [raw] = await runBQQuery(sql)

    const rows = (raw as Record<string, unknown>[]).map(row => {
      const out: Record<string, string | number | null> = {}
      for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v)
      return out
    })

    return NextResponse.json({ rows, rowCount: rows.length, executionMs: Date.now() - start })
  } catch (err: any) {
    console.error('[activity/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
