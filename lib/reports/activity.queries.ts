// SERVER-ONLY

const ARCHIVED_MAP: Record<string, string> = {
  'NUMIDA':          'NUMIDA ARCHIVED',
  'REMEDIAL HEALTH': 'REMEDIAL ARCHIVED',
  'KESSINGTON':      'KESSINGTON ARCHIVED',
}

// Accepts one or more institutions — always builds an IN (...) clause, expanding
// each institution's archived variant so multi-institution sums stay accurate.
function instFilter(institutions: string | string[]): string {
  const list = Array.isArray(institutions) ? institutions : [institutions]
  const expanded = new Set<string>()
  for (const inst of list) {
    expanded.add(inst)
    if (ARCHIVED_MAP[inst]) expanded.add(ARCHIVED_MAP[inst])
  }
  return `institution IN (${[...expanded].map(i => `'${i}'`).join(', ')})`
}

const NORMALISE_INST = `CASE
    WHEN institution = 'NUMIDA ARCHIVED'     THEN 'NUMIDA'
    WHEN institution = 'REMEDIAL ARCHIVED'   THEN 'REMEDIAL HEALTH'
    WHEN institution = 'KESSINGTON ARCHIVED' THEN 'KESSINGTON'
    ELSE institution
  END`

// CASE WHEN expression that assigns a bucket label based on arrears_days (MIN per client).
function bucketCaseExpr(institution: string): string {
  switch (institution) {
    case 'KUDA':
      return `CASE
        WHEN arrears_days >= 211 THEN '211+'
        WHEN arrears_days >= 110 THEN '110+'
        ELSE NULL
      END`
    case 'CREDIT DIRECT':
    case 'GROOMING MFB':
    case 'VICTORY EMPOWERMENT':
      return `CASE
        WHEN arrears_days > 90               THEN '91+'
        WHEN arrears_days BETWEEN 61 AND 90  THEN '61-90'
        WHEN arrears_days BETWEEN 31 AND 60  THEN '31-60'
        ELSE NULL
      END`
    case 'NUMIDA':
      return `CASE
        WHEN arrears_days > 90               THEN '91+'
        WHEN arrears_days BETWEEN 61 AND 90  THEN '61-90'
        ELSE NULL
      END`
    case 'NOLT':
      return `CASE
        WHEN arrears_days > 180              THEN '181+'
        WHEN arrears_days BETWEEN 91 AND 180 THEN '91-180'
        WHEN arrears_days BETWEEN 61 AND 90  THEN '61-90'
        WHEN arrears_days BETWEEN 31 AND 60  THEN '31-60'
        ELSE NULL
      END`
    case 'PEZESHA':
      return `CASE
        WHEN arrears_days > 360               THEN '360+'
        WHEN arrears_days BETWEEN 181 AND 360 THEN '181-360'
        WHEN arrears_days BETWEEN 91  AND 180 THEN '91-180'
        ELSE NULL
      END`
    default:
      return 'CAST(NULL AS STRING)'
  }
}

export function buildActivityQuery(
  institution: string | string[],
  df: string,
  dt: string,
  bucket = 'ALL',
): string {
  const list = Array.isArray(institution) ? institution : [institution]
  return list.length === 1 && list[0] === 'ALL'
    ? buildAllQuery(df, dt)
    : buildSingleQuery(list, df, dt, bucket)
}

// NUMIDA/PEZESHA store amounts in KES; everything else is NGN. Summing more than
// one institution together needs an FX pass whenever the mix could include both.
const KES_INSTITUTIONS_SQL = `'NUMIDA', 'NUMIDA ARCHIVED', 'PEZESHA'`

function moneyExpr(col: string, institutions: string[]): string {
  return institutions.length > 1
    ? `${col} * CASE WHEN institution IN (${KES_INSTITUTIONS_SQL}) THEN fx.ngn_per_unit ELSE 1 END`
    : col
}

// Handles both a single institution (bucket breakdown available) and multiple
// institutions summed into one combined row (bucket breakdown skipped — arrears
// bucket boundaries are institution-specific and don't compose across institutions).
function buildSingleQuery(institutions: string[], df: string, dt: string, bucket: string): string {
  const bucketExpr = institutions.length === 1 ? bucketCaseExpr(institutions[0]) : 'CAST(NULL AS STRING)'
  const bucketFilter = institutions.length === 1 && bucket !== 'ALL' ? `WHERE bucket = '${bucket}'` : ''
  const fxJoin = institutions.length > 1
    ? `CROSS JOIN (
    SELECT ngn_per_unit
    FROM \`fssspark.recovery_methods_data.currency_conversion_rates\`
    WHERE currency_code = 'KES'
    QUALIFY ROW_NUMBER() OVER (ORDER BY rate_date DESC) = 1
  ) fx`
    : ''

  return `
WITH raw_metrics AS (
  SELECT
    client_id,
    MIN(min_days_in_arrears)                               AS arrears_days,
    MAX(${moneyExpr('total_assigned_amount_due', institutions)})  AS total_assigned,
    SUM(${moneyExpr('daily_deposit_all', institutions)})          AS amount_recovered,
    SUM(daily_agent_inbound)                               AS inbound_calls,
    SUM(daily_agent_outbound)                              AS outbound_calls,
    SUM(daily_vb_outbound)                                 AS vbs,
    SUM(va_bot)                                            AS va_bot_calls,
    SUM(combined_agent_whatsapp) + SUM(bot_whatsapp)       AS whatsapp,
    SUM(combined_agent_whatsapp)                           AS agent_whatsapp,
    SUM(bot_whatsapp)                                      AS bot_whatsapp,
    SUM(daily_sms_success)                                 AS sms,
    SUM(daily_sms_pending_count)                           AS sms_pending,
    SUM(daily_sms_failed_count)                            AS sms_failed,
    SUM(daily_vb_na)                                       AS vb_na,
    SUM(daily_email_all_success)                           AS email_success,
    SUM(daily_email_all_failed)                            AS email_failed,
    SUM(daily_email_inbound)                               AS email_inbound,
    SUM(daily_email_outbound_success)                      AS email_outbound,
    SUM(daily_email_campaign_success)                      AS email_campaign
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  ${fxJoin}
  WHERE ${instFilter(institutions)}
    AND DATE(date) BETWEEN '${df}' AND '${dt}'
  GROUP BY client_id
),
metrics AS (
  SELECT *, ${bucketExpr} AS bucket
  FROM raw_metrics
)
SELECT
  COUNT(*)                                                                      AS total_customers,
  COUNTIF(amount_recovered > 0)                                                 AS paying_customers,
  SAFE_DIVIDE(COUNTIF(amount_recovered > 0), COUNT(*))                          AS conversion_rate,
  SUM(total_assigned)                                                            AS total_assigned,
  SUM(amount_recovered)                                                          AS amount_recovered,
  SAFE_DIVIDE(SUM(amount_recovered), NULLIF(SUM(total_assigned), 0))             AS recovery_rate,
  MAX(arrears_days)                                                              AS max_days_in_arrears,
  SUM(inbound_calls)                                                             AS inbound_calls,
  SUM(outbound_calls)                                                            AS outbound_calls,
  SUM(vbs)                                                                       AS vbs,
  SUM(va_bot_calls)                                                              AS va_bot_calls,
  SUM(inbound_calls) + SUM(outbound_calls) + SUM(vbs) + SUM(va_bot_calls)       AS total_calls,
  SUM(whatsapp)                                                                  AS total_whatsapp,
  SUM(agent_whatsapp)                                                            AS agent_whatsapp,
  SUM(bot_whatsapp)                                                              AS bot_whatsapp,
  SUM(sms)                                                                       AS sms,
  SUM(sms_pending)                                                               AS sms_pending,
  SUM(sms_failed)                                                                AS sms_failed,
  SUM(vb_na)                                                                     AS vb_na,
  SUM(email_success)                                                             AS email_success,
  SUM(email_failed)                                                              AS email_failed,
  SUM(email_inbound)                                                             AS email_inbound,
  SUM(email_outbound)                                                            AS email_outbound,
  SUM(email_campaign)                                                            AS email_campaign
FROM metrics
${bucketFilter}
`.trim()
}

function buildAllQuery(df: string, dt: string): string {
  return `
WITH metrics AS (
  SELECT
    ${NORMALISE_INST}                                      AS institution,
    client_id,
    MIN(min_days_in_arrears)                               AS arrears_days,
    MAX(total_assigned_amount_due)                         AS total_assigned,
    SUM(daily_deposit_all)                                 AS amount_recovered,
    SUM(daily_agent_inbound)                               AS inbound_calls,
    SUM(daily_agent_outbound)                              AS outbound_calls,
    SUM(daily_vb_outbound)                                 AS vbs,
    SUM(va_bot)                                            AS va_bot_calls,
    SUM(combined_agent_whatsapp) + SUM(bot_whatsapp)       AS whatsapp,
    SUM(combined_agent_whatsapp)                           AS agent_whatsapp,
    SUM(bot_whatsapp)                                      AS bot_whatsapp,
    SUM(daily_sms_success)                                 AS sms,
    SUM(daily_sms_pending_count)                           AS sms_pending,
    SUM(daily_sms_failed_count)                            AS sms_failed,
    SUM(daily_vb_na)                                       AS vb_na,
    SUM(daily_email_all_success)                           AS email_success,
    SUM(daily_email_all_failed)                            AS email_failed,
    SUM(daily_email_inbound)                               AS email_inbound,
    SUM(daily_email_outbound_success)                      AS email_outbound,
    SUM(daily_email_campaign_success)                      AS email_campaign
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  WHERE DATE(date) BETWEEN '${df}' AND '${dt}'
  GROUP BY 1, 2
)
SELECT
  institution,
  COUNT(*)                                                                      AS total_customers,
  COUNTIF(amount_recovered > 0)                                                 AS paying_customers,
  SAFE_DIVIDE(COUNTIF(amount_recovered > 0), COUNT(*))                          AS conversion_rate,
  SUM(total_assigned)                                                            AS total_assigned,
  SUM(amount_recovered)                                                          AS amount_recovered,
  SAFE_DIVIDE(SUM(amount_recovered), NULLIF(SUM(total_assigned), 0))             AS recovery_rate,
  MAX(arrears_days)                                                              AS max_days_in_arrears,
  SUM(inbound_calls)                                                             AS inbound_calls,
  SUM(outbound_calls)                                                            AS outbound_calls,
  SUM(vbs)                                                                       AS vbs,
  SUM(va_bot_calls)                                                              AS va_bot_calls,
  SUM(inbound_calls) + SUM(outbound_calls) + SUM(vbs) + SUM(va_bot_calls)       AS total_calls,
  SUM(whatsapp)                                                                  AS total_whatsapp,
  SUM(agent_whatsapp)                                                            AS agent_whatsapp,
  SUM(bot_whatsapp)                                                              AS bot_whatsapp,
  SUM(sms)                                                                       AS sms,
  SUM(sms_pending)                                                               AS sms_pending,
  SUM(sms_failed)                                                                AS sms_failed,
  SUM(vb_na)                                                                     AS vb_na,
  SUM(email_success)                                                             AS email_success,
  SUM(email_failed)                                                              AS email_failed,
  SUM(email_inbound)                                                             AS email_inbound,
  SUM(email_outbound)                                                            AS email_outbound,
  SUM(email_campaign)                                                            AS email_campaign
FROM metrics
GROUP BY 1
ORDER BY amount_recovered DESC
`.trim()
}
