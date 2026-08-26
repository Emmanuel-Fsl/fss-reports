import { runBQQuery } from './client'
import type { ReportFilters, ReportRow, RunReportResponse } from '@/types'
import { archivedVariantsOf } from '@/lib/reports/reports.config'

function normalizeValue(value: unknown): string | number | null {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value instanceof Date) return value.toISOString().slice(0, 10)

  if (Array.isArray(value)) {
    return value.map(v => normalizeValue(v) ?? '').join(', ')
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>

    // BigQuery wrapper types often expose scalar values via `.value`.
    if (typeof v.value === 'string' || typeof v.value === 'number') {
      return v.value
    }

    if (typeof (value as { toISOString?: () => string }).toISOString === 'function') {
      return (value as { toISOString: () => string }).toISOString().slice(0, 10)
    }

    if (typeof (value as { toString?: () => string }).toString === 'function') {
      const str = (value as { toString: () => string }).toString()
      if (str && str !== '[object Object]') return str
    }

    return JSON.stringify(value)
  }

  return String(value)
}

function normalizeRows(rows: unknown[]): ReportRow[] {
  return rows.map(row => {
    const obj = row as Record<string, unknown>
    const normalized: ReportRow = {}
    for (const [key, value] of Object.entries(obj)) {
      normalized[key] = normalizeValue(value)
    }
    return normalized
  })
}

/**
 * Run a report query against BigQuery.
 * If the report config has a buildQuery fn, it uses that.
 * Otherwise it looks up the named query from QUERY_MAP below.
 */
export async function runQuery(
  bqKey: string,
  filters: ReportFilters,
): Promise<RunReportResponse> {
  const start = Date.now()

  const { REPORTS } = await import('@/lib/reports/reports.config')
  const reportConfig = REPORTS.find(r => r.bqKey === bqKey)

  let sql: string

  if (reportConfig?.buildQuery) {
    // Use the report's own query builder (handles per-institution logic etc.)
    sql = reportConfig.buildQuery(filters)
  } else {
    // Fall back to the named query map below
    const builder = QUERY_MAP[bqKey]
    if (!builder) throw new Error(`No query found for bqKey: ${bqKey}`)
    sql = builder(filters)
  }

  const [rows] = await runBQQuery(sql)
  const normalizedRows = normalizeRows(rows as unknown[])

  return {
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    executionMs: Date.now() - start,
  }
}

// ─── Named query builders ─────────────────────────────────────────────────────
// Add a builder here for each report that doesn't use buildQuery in the config.
// Filters are passed in from the API route.

type QueryBuilder = (filters: ReportFilters) => string

const QUERY_MAP: Record<string, QueryBuilder> = {

  bq_daily_collections: ({ institution, dateFrom, dateTo }) => {
    const inst = institution?.trim()
    const instClause = inst ? `AND d.institution = '${inst}'` : ''
    return `
      SELECT
        d.date          AS date,
        d.institution   AS institution,
        d.client_id     AS client_id,
        l.full_name     AS full_name,
        d.daily_deposit_all AS amount,
        d.agent_name    AS agent,
        d.payment_channel AS channel,
        ANY_VALUE(l.loan_id) AS loan_id
      FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
      LEFT JOIN \`fssspark.original_cohorts.all_leads\` l
        ON d.client_id = l.client_id
      WHERE daily_deposit_all > 0
        ${instClause}
        AND date BETWEEN '${dateFrom}' AND '${dateTo}'
      GROUP BY 1,2,3,4,5,6,7
      ORDER BY date DESC
    `.trim()
  },

  bq_loan_aging: ({ institution, dateTo }) => {
    const inst = institution?.trim()
    const instClause = inst ? `AND institution = '${inst}'` : ''
    return `
      SELECT
        client_id,
        full_name,
        institution,
        days_past_due                                   AS dpd,
        CASE
          WHEN days_past_due BETWEEN 0  AND 30  THEN '0–30 DPD'
          WHEN days_past_due BETWEEN 31 AND 60  THEN '31–60 DPD'
          WHEN days_past_due BETWEEN 61 AND 90  THEN '61–90 DPD'
          ELSE '90+ DPD'
        END                                             AS bucket,
        net_balance                                     AS outstanding,
        last_payment_date                               AS last_payment,
        loan_officer,
        product_type,
        interest_accrued
      FROM \`fssspark.recovery_methods_data.loan_aging_view\`
      WHERE date = '${dateTo}'
        ${instClause}
      ORDER BY days_past_due DESC
    `.trim()
  },

  bq_agent_performance: ({ institution, dateFrom, dateTo }) => {
    const inst = institution?.trim()
    const instClause = inst ? `AND institution = '${inst}'` : ''
    return `
      SELECT
        agent_name              AS agent,
        COUNT(call_id)          AS calls,
        SUM(ptp_set)            AS ptp_count,
        SUM(ptp_kept)           AS ptp_kept,
        SUM(amount_recovered)   AS recovered,
        ROUND(SAFE_DIVIDE(SUM(ptp_kept), SUM(ptp_set)) * 100, 1) AS conversion_rate,
        AVG(call_duration_secs) AS avg_call_duration,
        COUNT(DISTINCT client_id) AS accounts_handled,
        SUM(escalation_flag)    AS escalations,
        team
      FROM \`fssspark.recovery_methods_data.agent_calls_table\`
      WHERE date BETWEEN '${dateFrom}' AND '${dateTo}'
        ${instClause}
      GROUP BY agent_name, team
      ORDER BY recovered DESC
    `.trim()
  },

  bq_ptp_tracker: ({ institution, dateFrom, dateTo, status }) => {
    const inst = institution?.trim()
    const instClause = inst ? `AND institution = '${inst}'` : ''
    const statusClause = status && status !== 'All Statuses'
      ? `AND ptp_status = '${status.toLowerCase()}'`
      : ''
    return `
      SELECT
        client_id,
        full_name,
        ptp_date,
        ptp_amount,
        ptp_status              AS status,
        agent_name              AS agent,
        institution,
        amount_kept             AS kept_amount,
        follow_up_date,
        notes
      FROM \`fssspark.recovery_methods_data.ptp_tracker_table\`
      WHERE ptp_date BETWEEN '${dateFrom}' AND '${dateTo}'
        ${instClause}
        ${statusClause}
      ORDER BY ptp_date DESC
    `.trim()
  },

  bq_weekly_trend: ({ institution, year }) => {
    const y    = year?.trim() ? parseInt(year) : new Date().getFullYear()
    const inst = institution?.trim()
    const instClause  = !inst
      ? ''
      : `AND institution IN (${[inst, ...archivedVariantsOf(inst)].map(v => `'${v}'`).join(', ')})`

    return `
      SELECT
        CONCAT('Week ', CAST(CEIL(EXTRACT(DAY FROM DATE(date)) / 7) AS STRING)) AS week,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 1  THEN daily_deposit_all ELSE 0 END) AS jan,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 2  THEN daily_deposit_all ELSE 0 END) AS feb,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 3  THEN daily_deposit_all ELSE 0 END) AS mar,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 4  THEN daily_deposit_all ELSE 0 END) AS apr,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 5  THEN daily_deposit_all ELSE 0 END) AS may,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 6  THEN daily_deposit_all ELSE 0 END) AS jun,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 7  THEN daily_deposit_all ELSE 0 END) AS jul,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 8  THEN daily_deposit_all ELSE 0 END) AS aug,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 9  THEN daily_deposit_all ELSE 0 END) AS sep,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 10 THEN daily_deposit_all ELSE 0 END) AS oct,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 11 THEN daily_deposit_all ELSE 0 END) AS nov,
        SUM(CASE WHEN EXTRACT(MONTH FROM DATE(date)) = 12 THEN daily_deposit_all ELSE 0 END) AS dec
      FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
      WHERE EXTRACT(YEAR FROM DATE(date)) = ${y}
        ${instClause}
      GROUP BY week
      ORDER BY MIN(date)
    `.trim()
  },

  bq_institution_summary: ({ dateFrom, dateTo }) => `
    SELECT
      institution,
      COUNT(DISTINCT client_id)   AS total_accounts,
      MAX(total_assigned_amount_due) AS total_outstanding,
      SUM(daily_deposit_all)      AS total_recovered,
      ROUND(SAFE_DIVIDE(SUM(daily_deposit_all), MAX(total_assigned_amount_due)) * 100, 1) AS recovery_rate,
      COUNTIF(status = 'active')  AS active_count,
      COUNTIF(status = 'overdue') AS overdue_count,
      AVG(days_past_due)          AS avg_dpd,
      COUNT(DISTINCT agent_name)  AS agents_assigned
    FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
    WHERE date BETWEEN '${dateFrom}' AND '${dateTo}'
    GROUP BY institution
    ORDER BY total_recovered DESC
  `.trim(),
}
