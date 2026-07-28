import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'
import { runCloudRunJob }            from '@/lib/cloudRunJobs'

export const maxDuration = 30

interface EmailBody {
  to:            string[]
  dateFrom:      string
  dateTo:        string
  depositTo?:    string
  institution?:  string
  institutions?: string[]
}

export async function POST(req: NextRequest) {
  try {
    await verifyToken(req.headers.get('Authorization'))

    const body = (await req.json()) as EmailBody

    if (!body.to?.length) {
      return NextResponse.json({ error: 'No recipients specified' }, { status: 400 })
    }

    const jobName = process.env.RECOVERY_PDF_JOB_NAME
    if (!jobName) {
      return NextResponse.json({ error: 'RECOVERY_PDF_JOB_NAME not configured' }, { status: 500 })
    }

    const institutions = body.institutions?.length ? body.institutions : (body.institution ? [body.institution] : [])

    // Queues a Cloud Run Job execution and returns immediately — the job runs
    // PDF generation + email send to completion on its own, with Cloud Run's
    // own retry semantics (--max-retries) rather than a background thread
    // inside a request handler.
    await runCloudRunJob(jobName, {
      JOB_TO:              body.to.join(','),
      REPORT_DATE_FROM:    body.dateFrom,
      REPORT_DATE_TO:      body.dateTo,
      REPORT_DEPOSIT_TO:   body.depositTo ?? '',
      REPORT_INSTITUTIONS: institutions.join(','),
    })

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[recovery-methods/email]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
