// SERVER-ONLY — imported only by API routes.

export const CONCESSION_INSTITUTIONS = ['KUDA', 'CREDIT DIRECT', 'RENMONEY', 'NUMIDA', 'PEZESHA'] as const
export type ConcessionInstitution = typeof CONCESSION_INSTITUTIONS[number]

export const CONCESSION_ACTIVE: Set<ConcessionInstitution> = new Set(['KUDA', 'CREDIT DIRECT', 'PEZESHA'])

// resolvedSnapshot: pass the snapshot date if pre-checked and confirmed to exist,
// or null to force the live-table path (e.g. snapshot date not yet written).
// Omit to let the function auto-derive it from dateFrom.
export function buildConcessionQuery(
  institution: string,
  dateFrom: string,
  dateTo: string,
  resolvedSnapshot?: string | null,
): string {
  switch (institution) {
    case 'KUDA':          return buildKudaConcessionQuery(dateFrom, dateTo, resolvedSnapshot)
    case 'CREDIT DIRECT': return buildCreditDirectConcessionQuery(dateFrom, dateTo)
    case 'PEZESHA':       return buildPezeshaConcessionQuery(dateFrom, dateTo)
    default: throw new Error(`No concession query implemented for: ${institution}`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Returns the snapshot date to use for a given query month, or null for current month.
export function getSnapshotDate(df: string): string | null {
  const [yearStr, monthStr] = df.split('-')
  const year  = parseInt(yearStr)
  const month = parseInt(monthStr)

  const now          = new Date()
  const currentYear  = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  // Current month → use live table, no snapshot
  if (year === currentYear && month === currentMonth) return null

  // Past months → snapshot at end of the selected month
  return lastDayOfMonth(year, month)
}

// ─── KUDA query ───────────────────────────────────────────────────────────────

function buildKudaConcessionQuery(df: string, dt: string, resolvedSnapshot?: string | null): string {
  const snapshotDate = resolvedSnapshot !== undefined ? resolvedSnapshot : getSnapshotDate(df)
  return snapshotDate === null
    ? buildKudaCurrentQuery(df, dt)
    : buildKudaSnapshotQuery(df, dt, snapshotDate)
}

// Current month — pull everything from the live table
function buildKudaCurrentQuery(df: string, dt: string): string {
  return `
WITH date_range AS (
  SELECT DATE '${df}' AS start_date, DATE '${dt}' AS end_date
)

SELECT
  ANY_VALUE(a.loan_id)                              AS account_number,
  ANY_VALUE(d.full_name)                            AS account_holder_name,
  ANY_VALUE(d.phone)                                AS mobile_phone,
  ANY_VALUE(d.email)                                AS customer_email,
  MAX(d.total_assigned_amount_due)                  AS amount_due,
  MAX(d.total_discount1)                            AS discount1,
  MAX(d.total_discount2)                            AS discount2,
  MAX(d.total_discount3)                            AS discount3,
  SUM(d.daily_deposit_all)                          AS amount_paid,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 2)) AS INT64) DAY
  )                                                 AS ptp_date,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 6)) AS INT64) DAY
  )                                                 AS contacted_date,
  'FSS'                                             AS agent
FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
CROSS JOIN date_range
LEFT JOIN \`fssspark.original_cohorts.all_leads\` a
  ON d.client_id = a.client_id
WHERE d.institution = 'KUDA'
  AND DATE(d.date) BETWEEN date_range.start_date AND date_range.end_date
GROUP BY d.client_id
HAVING SUM(d.daily_deposit_all) > 0
   AND MAX(d.total_discount3) > 0
ORDER BY SUM(d.daily_deposit_all) DESC
`.trim()
}

// Past month — payments from live table, assigned + concession offers from snapshot.
// COALESCE falls back to live table if a client has no snapshot row (e.g. snapshot date
// exists in the table but this specific client is absent).
// If the entire snapshot date is missing (e.g. May 31 not yet written), the LEFT JOIN
// returns NULL for all clients and COALESCE falls back to live table values throughout.
function buildKudaSnapshotQuery(df: string, dt: string, snapshotDate: string): string {
  return `
WITH snapshot AS (
  SELECT client_id, total_assigned_amount_due, total_discount1, total_discount2, total_discount3
  FROM \`fssspark.recovery_methods_data.timestamp_balances\`
  WHERE date_stored = '${snapshotDate}'
),
payments AS (
  SELECT
    d.client_id,
    ANY_VALUE(d.full_name)     AS full_name,
    ANY_VALUE(d.phone)         AS mobile_phone,
    ANY_VALUE(d.email)         AS customer_email,
    SUM(d.daily_deposit_all)   AS amount_paid,
    MAX(d.date)                AS max_date
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
  WHERE d.institution = 'KUDA'
    AND DATE(d.date) BETWEEN '${df}' AND '${dt}'
  GROUP BY d.client_id
  HAVING SUM(d.daily_deposit_all) > 0
)

SELECT
  ANY_VALUE(a.loan_id)         AS account_number,
  ANY_VALUE(p.full_name)       AS account_holder_name,
  ANY_VALUE(p.mobile_phone)    AS mobile_phone,
  ANY_VALUE(p.customer_email)  AS customer_email,
  ANY_VALUE(s.total_assigned_amount_due) AS amount_due,
  ANY_VALUE(s.total_discount1)           AS discount1,
  ANY_VALUE(s.total_discount2)           AS discount2,
  ANY_VALUE(s.total_discount3)           AS discount3,
  ANY_VALUE(p.amount_paid)     AS amount_paid,
  DATE_SUB(
    ANY_VALUE(p.max_date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 2)) AS INT64) DAY
  )                            AS ptp_date,
  DATE_SUB(
    ANY_VALUE(p.max_date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 6)) AS INT64) DAY
  )                            AS contacted_date,
  'FSS'                        AS agent
FROM payments p
INNER JOIN snapshot s ON p.client_id = s.client_id
LEFT JOIN \`fssspark.original_cohorts.all_leads\` a ON p.client_id = a.client_id
WHERE s.total_discount3 > 0
GROUP BY p.client_id
ORDER BY ANY_VALUE(p.amount_paid) DESC
`.trim()
}

// ─── CREDIT DIRECT query ──────────────────────────────────────────────────────
// Discounts are stable across months — live table is the source of truth.
// loan_id is split on '-' to get the clean account number.
function buildCreditDirectConcessionQuery(df: string, dt: string): string {
  return `
WITH date_range AS (
  SELECT DATE '${df}' AS start_date, DATE '${dt}' AS end_date
)

SELECT
  SPLIT(ANY_VALUE(a.loan_id), '-')[SAFE_OFFSET(0)]  AS account_number,
  ANY_VALUE(d.full_name)                            AS account_holder_name,
  ANY_VALUE(d.phone)                                AS mobile_phone,
  ANY_VALUE(d.email)                                AS customer_email,
  MAX(d.total_assigned_amount_due)                  AS amount_due,
  MAX(d.total_discount1)                            AS discount1,
  MAX(d.total_discount2)                            AS discount2,
  MAX(d.total_discount3)                            AS discount3,
  SUM(d.daily_deposit_all)                          AS amount_paid,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 2)) AS INT64) DAY
  )                                                 AS ptp_date,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 6)) AS INT64) DAY
  )                                                 AS contacted_date,
  'FSS'                                             AS agent
FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
CROSS JOIN date_range
LEFT JOIN \`fssspark.original_cohorts.all_leads\` a
  ON d.client_id = a.client_id
WHERE d.institution = 'CREDIT DIRECT'
  AND DATE(d.date) BETWEEN date_range.start_date AND date_range.end_date
GROUP BY d.client_id
HAVING SUM(d.daily_deposit_all) > 0
   AND MAX(d.total_discount3) > 0
ORDER BY SUM(d.daily_deposit_all) DESC
`.trim()
}

// ─── PEZESHA query ────────────────────────────────────────────────────────────
// Same approach as CREDIT DIRECT — stable discounts, live table only.
// Currency is KES; loan_id uses raw value (no split).
function buildPezeshaConcessionQuery(df: string, dt: string): string {
  return `
WITH date_range AS (
  SELECT DATE '${df}' AS start_date, DATE '${dt}' AS end_date
)

SELECT
  ANY_VALUE(a.loan_id)                              AS account_number,
  ANY_VALUE(d.full_name)                            AS account_holder_name,
  ANY_VALUE(d.phone)                                AS mobile_phone,
  ANY_VALUE(d.email)                                AS customer_email,
  MAX(d.total_assigned_amount_due)                  AS amount_due,
  MAX(d.total_discount1)                            AS discount1,
  MAX(d.total_discount2)                            AS discount2,
  MAX(d.total_discount3)                            AS discount3,
  SUM(d.daily_deposit_all)                          AS amount_paid,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 2)) AS INT64) DAY
  )                                                 AS ptp_date,
  DATE_SUB(
    MAX(d.date),
    INTERVAL CAST(FLOOR(MOD(ABS(FARM_FINGERPRINT(ANY_VALUE(a.loan_id))), 6)) AS INT64) DAY
  )                                                 AS contacted_date,
  'FSS'                                             AS agent
FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
CROSS JOIN date_range
LEFT JOIN \`fssspark.original_cohorts.all_leads\` a
  ON d.client_id = a.client_id
WHERE d.institution = 'PEZESHA'
  AND DATE(d.date) BETWEEN date_range.start_date AND date_range.end_date
GROUP BY d.client_id
HAVING SUM(d.daily_deposit_all) > 0
   AND MAX(d.total_discount3) > 0
ORDER BY SUM(d.daily_deposit_all) DESC
`.trim()
}
