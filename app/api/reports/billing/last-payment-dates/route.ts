import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runBQQuery }                from '@/lib/bq/client'

// Date of FSS's inception — the earliest possible payment date
const INCEPTION_DATE = '2025-05-07'

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const sql = `
      SELECT
        CASE
          WHEN institution = 'NUMIDA ARCHIVED'     THEN 'NUMIDA'
          WHEN institution = 'REMEDIAL ARCHIVED'   THEN 'REMEDIAL HEALTH'
          WHEN institution = 'KESSINGTON ARCHIVED' THEN 'KESSINGTON'
          ELSE institution
        END AS institution,
        FORMAT_DATE('%Y-%m-%d', MAX(date)) AS last_payment_date
      FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
      WHERE daily_deposit_all > 0
        AND date BETWEEN '${INCEPTION_DATE}' AND CURRENT_DATE()
      GROUP BY 1
    `.trim()

    const [rows] = await runBQQuery(sql)

    const result: Record<string, string> = {}
    for (const row of rows as Array<{ institution: string; last_payment_date: string }>) {
      if (row.institution && row.last_payment_date) {
        result[row.institution] = String(row.last_payment_date).slice(0, 10)
      }
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[billing/last-payment-dates]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
