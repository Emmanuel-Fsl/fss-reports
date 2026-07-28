import { NextRequest, NextResponse }        from 'next/server'
import { verifyToken }                      from '@/lib/firebase/admin'
import { runBQQuery }                       from '@/lib/bq/client'
import { buildRecoveryMethodsQuery }        from '@/lib/reports/recovery-methods.queries'

export const maxDuration = 300

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

function normalizeRows(rows: unknown[]): Record<string, string | number | null>[] {
  return rows.map(row => {
    const obj = row as Record<string, unknown>
    const out: Record<string, string | number | null> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = normalizeValue(v)
    return out
  })
}

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))
    const { institution, institutions, dateFrom, dateTo, depositTo } = await req.json()
    const start = Date.now()

    const sql  = buildRecoveryMethodsQuery({ institution, institutions, dateFrom, dateTo, depositTo })
    const [raw] = await runBQQuery(sql)
    const rows  = normalizeRows(raw as unknown[])

    return NextResponse.json({
      rows,
      rowCount:    rows.length,
      executionMs: Date.now() - start,
    })
  } catch (err: any) {
    console.error('[recovery-methods/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
