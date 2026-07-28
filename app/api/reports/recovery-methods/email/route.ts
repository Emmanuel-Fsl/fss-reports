import { NextRequest, NextResponse } from 'next/server'
import { verifyToken }               from '@/lib/firebase/admin'

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

    const serviceUrl = process.env.RECOVERY_PDF_SERVICE_URL
    const authToken  = process.env.RECOVERY_PDF_AUTH_TOKEN
    if (!serviceUrl || !authToken) {
      return NextResponse.json({ error: 'RECOVERY_PDF_SERVICE_URL / RECOVERY_PDF_AUTH_TOKEN not configured' }, { status: 500 })
    }

    // Fire-and-forget: the Render service spawns a background thread and
    // returns immediately — PDF generation + email send happen on its own.
    const res = await fetch(`${serviceUrl}/generate-and-email`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`recovery-pdf service returned ${res.status}: ${await res.text()}`)
    }

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[recovery-methods/email]', err)
    const status = err.message?.includes('Authorization') ? 401 : 500
    return NextResponse.json({ error: err.message }, { status })
  }
}
