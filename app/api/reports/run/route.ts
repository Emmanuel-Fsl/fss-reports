import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runQuery }                  from '@/lib/bq/queries'
import { runBQQuery }                from '@/lib/bq/client'
import { buildFxRateQuery }          from '@/lib/reports/agent-performance.queries'
import type { RunReportPayload }     from '@/types'

export async function POST(req: NextRequest) {
  try {
    // Auth
    await verifyToken(req.headers.get('Authorization'))

    const body: RunReportPayload = await req.json()
    const { bqKey, filters } = body

    if (!bqKey) {
      return NextResponse.json({ error: 'bqKey is required' }, { status: 400 })
    }

    const [result, [fxRows]] = await Promise.all([
      runQuery(bqKey, filters),
      runBQQuery(buildFxRateQuery()),
    ])
    const fxRate = Number((fxRows as Record<string, unknown>[])[0]?.ngn_per_unit ?? 10.5)

    return NextResponse.json({ ...result, fxRate })
  } catch (err: any) {
    console.error('[reports/run]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
