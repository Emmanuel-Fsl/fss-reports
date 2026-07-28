import { BigQuery } from '@google-cloud/bigquery'

const DAILY_TABLE = 'recovery_dashboard_daily_table'
const DAILY_VIEW  = 'recovery_dashboard_daily'

// Singleton BQ client reused across API route invocations in the same worker.
let client: BigQuery | null = null

export function getBQClient(): BigQuery {
  if (client) return client

  const projectId = process.env.BQ_PROJECT_ID ?? process.env.BIGQUERY_PROJECT_ID ?? 'fssspark'

  // Preferred in hosted environments: full credentials JSON in one env var.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
    client = new BigQuery({
      projectId,
      credentials,
    })
  } else if (process.env.BIGQUERY_CLIENT_EMAIL && process.env.BIGQUERY_PRIVATE_KEY) {
    // Fallback for split env vars commonly used in .env.local.
    client = new BigQuery({
      projectId,
      credentials: {
        project_id: projectId,
        client_email: process.env.BIGQUERY_CLIENT_EMAIL,
        private_key: process.env.BIGQUERY_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
    })
  } else {
    // Local dev fallback: ADC (or key file path via GOOGLE_APPLICATION_CREDENTIALS).
    client = new BigQuery({ projectId })
  }

  return client
}

/**
 * Run a query via a BigQuery job (createQueryJob → getQueryResults).
 * Avoids socket hang-ups from long-running synchronous queries.
 */
async function runJobQuery(bq: BigQuery, sql: string, location: string) {
  const [job] = await bq.createQueryJob({ query: sql, location })
  const [rows] = await job.getQueryResults({ autoPaginate: true })
  return [rows]
}

/**
 * Run a BigQuery query with automatic fallback.
 * Tries recovery_dashboard_daily_table first. If that table is temporarily
 * unavailable or not found, retries once against the recovery_dashboard_daily
 * view and logs a warning.
 */
export async function runBQQuery(sql: string, location = 'US') {
  const bq = getBQClient()
  try {
    return await runJobQuery(bq, sql, location)
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (sql.includes(DAILY_TABLE) && (
      msg.toLowerCase().includes('not found') ||
      msg.toLowerCase().includes('unavailable') ||
      msg.toLowerCase().includes(DAILY_TABLE)
    )) {
      console.warn('[BQ] recovery_dashboard_daily_table unavailable — falling back to view:', msg)
      return runJobQuery(bq, sql.replaceAll(DAILY_TABLE, DAILY_VIEW), location)
    }
    throw err
  }
}
