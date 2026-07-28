import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runQuery }                  from '@/lib/bq/queries'
import { toCSV }                     from '@/lib/reports/export'
import { REPORTS }                   from '@/lib/reports/reports.config'
import type { ExportPayload }        from '@/types'

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const body: ExportPayload = await req.json()
    const { bqKey, filters, columns: columnKeys, format, reportLabel } = body

    const reportConfig = REPORTS.find(r => r.bqKey === bqKey)
    if (!reportConfig) {
      return NextResponse.json({ error: 'Unknown report' }, { status: 400 })
    }

    // Resolve column defs from keys
    const allCols = [...reportConfig.coreColumns, ...reportConfig.extraColumns]
    const columns = columnKeys
      ? allCols.filter(c => columnKeys.includes(c.key))
      : reportConfig.coreColumns

    const { rows } = await runQuery(bqKey, filters)

    // CSV — stream directly from server
    if (format === 'csv') {
      const csv      = toCSV(rows, columns)
      const filename = `${reportConfig.id}_${filters.dateFrom ?? 'export'}.csv`
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type':        'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    // Excel / PDF — return the raw rows; client handles file generation
    // (avoids bundling heavy libs into the Edge/Node API route)
    return NextResponse.json({ rows, columns })

  } catch (err: any) {
    console.error('[reports/export]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
