// SERVER-ONLY — imported only by API routes, never by client components.
// Keeps large SQL template literals out of the client bundle.
import type { ReportFilters } from '@/types'
import { NO_LOAN_ID, NO_CLIENT_ID, NO_BALANCE } from './billing'

const CLIENT_ID_REPLACE: Record<string, string> = {
  'CREDIT DIRECT':   'C',
  'REMEDIAL HEALTH': 'R',
  'NUMIDA':          'N',
  'LUKEFIELD':       'L',
  'RENMONEY':        'RE',
}

// ─── Archived institution normalisation helpers ───────────────────────────────
const ARCHIVED_MAP: Record<string, string> = {
  'NUMIDA':          'NUMIDA ARCHIVED',
  'REMEDIAL HEALTH': 'REMEDIAL ARCHIVED',
  'KESSINGTON':      'KESSINGTON ARCHIVED',
}

function instWhereClause(field: string, inst: string): string {
  if (!inst) return ''
  const archived = ARCHIVED_MAP[inst]
  if (archived) return `AND ${field} IN ('${inst}', '${archived}')`
  return `AND ${field} = '${inst}'`
}

// ─── Summary query ────────────────────────────────────────────────────────────
export function buildBillingSummaryQuery({ institution, dateFrom, dateTo, groomingMfiSegment }: ReportFilters): string {
  const inst       = institution?.trim() ?? ''
  const instClause = instWhereClause('institution', inst)
  const df         = dateFrom ?? '2026-04-01'
  const dt         = dateTo   ?? '2026-04-30'

  const groomingFilter = (inst === 'GROOMING MFI' && groomingMfiSegment === '90+')
    ? "AND max_portfolio_upload_date >= '2026-04-09'"
    : (inst === 'GROOMING MFI' && groomingMfiSegment === '360+')
    ? "AND max_portfolio_upload_date < '2026-04-09'"
    : ''

  return `
-- Step 1: normalise institution names before any CASE logic runs.
WITH normed AS (
  SELECT
    CASE
      WHEN institution = 'NUMIDA ARCHIVED'     THEN 'NUMIDA'
      WHEN institution = 'REMEDIAL ARCHIVED'   THEN 'REMEDIAL HEALTH'
      WHEN institution = 'KESSINGTON ARCHIVED' THEN 'KESSINGTON'
      ELSE institution
    END AS institution,
    daily_deposit_all,
    min_days_in_arrears,
    min_days_in_arrears_running,
    date
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  WHERE date BETWEEN '${df}' AND '${dt}'
    AND daily_deposit_all > 0
    ${instClause}
    ${groomingFilter}
),
-- Step 2: bucket + commission now see the already-normalised institution name.
base AS (
  SELECT
    institution,
    daily_deposit_all,
    CASE
      WHEN institution = 'CREDIT DIRECT' AND min_days_in_arrears BETWEEN 31 AND 60 THEN '31-60'
      WHEN institution = 'CREDIT DIRECT' AND min_days_in_arrears BETWEEN 61 AND 90 THEN '61-90'
      WHEN institution = 'CREDIT DIRECT' AND min_days_in_arrears > 90              THEN '91+'
      WHEN institution = 'NUMIDA'        AND min_days_in_arrears_running BETWEEN 61 AND 90  THEN '61-90'
      WHEN institution = 'NUMIDA'        AND min_days_in_arrears_running > 90               THEN '91+'
      WHEN institution = 'PEZESHA'            AND min_days_in_arrears BETWEEN 91 AND 180  THEN '91-180'
      WHEN institution = 'PEZESHA'            AND min_days_in_arrears BETWEEN 181 AND 360 THEN '181-360'
      WHEN institution = 'PEZESHA'            AND min_days_in_arrears > 360               THEN '360+'
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears <= 60              THEN '0-60'
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears BETWEEN 61 AND 90  THEN '61-90'
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears > 90               THEN '91+'
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 31 AND 60  THEN '31-60'
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 61 AND 90  THEN '61-90'
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 91 AND 180 THEN '91-180'
      WHEN institution = 'NOLT'                AND min_days_in_arrears > 180              THEN '181+'
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears BETWEEN 31 AND 60  THEN '31-60'
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears BETWEEN 61 AND 90  THEN '61-90'
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears > 90               THEN '91+'
      ELSE 'ALL'
    END AS bucket,
    CASE
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears > 90               THEN 0.3
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears BETWEEN 61 AND 90  THEN 0.25
      WHEN institution = 'VICTORY EMPOWERMENT' AND min_days_in_arrears <= 60              THEN 0.20
      WHEN institution = 'KUDA'                                                            THEN 0.3
      WHEN institution = 'SYCAMORE MFB'                                                   THEN 0.325
      WHEN institution = 'SHARA'                                                           THEN 0.25
      WHEN institution = 'NUMIDA'              AND min_days_in_arrears_running > 90               THEN 0.3
      WHEN institution = 'NUMIDA'              AND min_days_in_arrears_running BETWEEN 61 AND 90  THEN 0.15
      WHEN institution IN ('REMEDIAL HEALTH', 'KESSINGTON')                                THEN 0.175
      WHEN institution = 'GROOMING MFI'        AND date >= '2026-04-01'                   THEN 0.195
      WHEN institution = 'GROOMING MFI'                                                   THEN 0.25
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears > 90               THEN 0.215
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears BETWEEN 61 AND 90  THEN 0.175
      WHEN institution = 'GROOMING MFB'        AND min_days_in_arrears BETWEEN 31 AND 60  THEN 0.10
      WHEN institution = 'ROSABON'                                                         THEN 0.135
      WHEN institution = 'LAPO'                                                            THEN 0.10
      WHEN institution = 'LUKEFIELD'                                                       THEN 0.2
      WHEN institution = 'NOLT'                AND min_days_in_arrears > 180               THEN 0.30
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 91 AND 180  THEN 0.20
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 61 AND 90   THEN 0.175
      WHEN institution = 'NOLT'                AND min_days_in_arrears BETWEEN 31 AND 60   THEN 0.15
      WHEN institution = 'PEZESHA'             AND min_days_in_arrears > 360               THEN 0.25
      WHEN institution = 'PEZESHA'             AND min_days_in_arrears BETWEEN 181 AND 360 THEN 0.2
      WHEN institution = 'PEZESHA'             AND min_days_in_arrears BETWEEN 91 AND 180  THEN 0.15
      WHEN institution = 'CREDIT DIRECT'       AND min_days_in_arrears > 90               THEN 0.15
      WHEN institution = 'CREDIT DIRECT'       AND min_days_in_arrears BETWEEN 31 AND 90  THEN 0.1
      WHEN institution = 'RENMONEY'            AND date > '2026-06-11'                    THEN 0.125
      WHEN institution = 'RENMONEY'                                                        THEN 0.15
      ELSE 0.25
    END AS commission
  FROM normed
)
SELECT
  '${df}'                                                                            AS start_date,
  '${dt}'                                                                            AS end_date,
  institution,
  bucket,
  SUM(daily_deposit_all)                                                             AS amount_recovered,
  commission,
  SUM(daily_deposit_all) * commission                                                AS revenue_pre_wht,
  SUM(daily_deposit_all) * commission * 0.05                                         AS wht_5pct,
  (SUM(daily_deposit_all) * commission) - (SUM(daily_deposit_all) * commission * 0.05) AS revenue_post_wht
FROM base
GROUP BY institution, bucket, commission
ORDER BY institution, bucket
`.trim()
}

// ─── Detail query (per institution) ──────────────────────────────────────────
export function buildBillingDetailQuery(inst: string, dateFrom: string, dateTo: string, groomingMfiSegment?: 'all' | '90+' | '360+'): string {
  const isCreditDirect = inst === 'CREDIT DIRECT'
  const isRenmoney     = inst === 'RENMONEY'
  const isKuda         = inst === 'KUDA'
  const needsLoan      = !NO_LOAN_ID.has(inst)
  const needsClient    = !NO_CLIENT_ID.has(inst)
  const needsBalance   = !NO_BALANCE.has(inst)
  const replaceLetter  = CLIENT_ID_REPLACE[inst] ?? null

  const cols: string[]     = []
  const groupPos: number[] = []
  let pos = 0

  const push = (expr: string, grouped: boolean) => {
    pos++
    cols.push(expr)
    if (grouped) groupPos.push(pos)
  }

  push('d.date AS `Date`', true)

  if (needsClient) {
    const clientExpr = replaceLetter
      ? `REPLACE(d.client_id, '${replaceLetter}', '')`
      : 'd.client_id'
    push(`${clientExpr} AS \`Client ID\``, true)
  }

  if (needsLoan) {
    const loanExpr  = (isCreditDirect || isRenmoney)
      ? "SPLIT(ANY_VALUE(l.loan_id), '-')[SAFE_OFFSET(0)]"
      : 'ANY_VALUE(l.loan_id)'
    const loanLabel = isKuda ? 'Account Number' : 'Loan ID'
    push(`${loanExpr} AS \`${loanLabel}\``, false)
  }

  push('fss_id AS `FSS ID`', true)
  push('d.phone AS `Phone`', true)
  push('d.email AS `Email`', true)

  if (isCreditDirect) {
    push('d.first_name  AS `First Name`',  true)
    push('d.surname     AS `Last Name`',   true)
    push('d.middle_name AS `Middle Name`', true)
    // Product and Payment Mode come from credit_direct_payment_details via CTE join below
  } else {
    push('d.full_name AS `Full Name`', true)
  }

  push('MAX(total_assigned_amount_due)                                AS `Assigned Amount`',  false)
  push('SUM(daily_deposit_all)                                        AS `Amount Recovered`', false)

  if (needsBalance) {
    push("ARRAY_AGG(net_balance ORDER BY date DESC LIMIT 1)[OFFSET(0)] AS `Current Loan Balance`", false)
  }

  if (isCreditDirect) {
    push("'FSL Digital' AS `EDC`", true)
  }

  const joinClause = needsLoan
    ? 'LEFT JOIN `fssspark.original_cohorts.all_leads` l ON d.client_id = l.client_id'
    : ''

  const groomingDetailFilter = (inst === 'GROOMING MFI' && groomingMfiSegment === '90+')
    ? "AND d.max_portfolio_upload_date >= '2026-04-09'"
    : (inst === 'GROOMING MFI' && groomingMfiSegment === '360+')
    ? "AND d.max_portfolio_upload_date < '2026-04-09'"
    : ''

  const innerQuery = `
SELECT
  ${cols.join(',\n  ')}
FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
${joinClause}
WHERE daily_deposit_all > 0
  ${instWhereClause('d.institution', inst)}
  AND date BETWEEN '${dateFrom}' AND '${dateTo}'
  ${groomingDetailFilter}
GROUP BY ${groupPos.join(', ')}
`.trim()

  if (isCreditDirect) {
    return `
WITH base_data AS (
  ${innerQuery.split('\n').join('\n  ')}
)
SELECT
  base_data.*,
  pd.product      AS \`Product\`,
  pd.payment_mode AS \`Payment Mode\`
FROM base_data
LEFT JOIN \`fssspark.recovery_methods_data.credit_direct_payment_details\` pd
  ON base_data.\`Loan ID\`  = pd.loan_id
  AND base_data.\`Date\`    = pd.transaction_date
`.trim()
  }

  return innerQuery
}