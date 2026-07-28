export const RECOVERY_METHODS_INSTITUTIONS = [
  'GROOMING MFI',
  'SHARA',
  'KUDA',
  'REMEDIAL HEALTH',
  'KESSINGTON',
  'CREDIT DIRECT',
] as const

export function buildRecoveryMethodsQuery(filters: {
  institution?:  string
  institutions?: string[]
  dateFrom?: string
  dateTo?: string
  depositTo?: string
}): string {
  const selectedInsts = filters.institutions?.length
    ? filters.institutions
    : filters.institution?.trim()
      ? [filters.institution.trim()]
      : []
  const df        = filters.dateFrom ?? '2026-04-01'
  const dt        = filters.dateTo   ?? '2026-04-30'
  // depositDt extends the window for deposit counting beyond the contact window
  const depositDt = (filters.depositTo && filters.depositTo > dt) ? filters.depositTo : dt
  const extended  = depositDt !== dt

  const instFilter = selectedInsts.length
    ? `AND cur.institution IN (${selectedInsts.map(i => `'${i}'`).join(', ')})`
    : `AND cur.institution IN (${RECOVERY_METHODS_INSTITUTIONS.map(i => `'${i}'`).join(', ')})`

  // When deposit period is extended, gate activity columns to the contact window (df→dt)
  // so a payment after dt isn't attributed to a contact that didn't happen
  const act = (col: string) => extended
    ? `CASE WHEN cur.date <= DATE '${dt}' THEN ${col} ELSE 0 END`
    : col

  return `
WITH base AS (
  SELECT
    cur.date,
    cur.tier,
    ${act('cur.daily_sms_success')}                                                  AS daily_sms_success,
    ${act('cur.daily_vb_outbound')}                                                  AS daily_vb_outbound,
    cur.cum_vb_outbound + cur.cum_sms_success
      + cur.cum_agent_outbound + cur.cum_agent_inbound
      + cur.cum_combined_agent_whatsapp
      + cur.cum_combined_agent_call_logged
      + cur.cum_combined_bot                                                         AS cum_rec,
    ${act('cur.daily_agent_outbound + cur.combined_agent_whatsapp + cur.daily_agent_inbound + cur.combined_agent_call_logged')} AS daily_agent_outbound,
    ${act('cur.combined_bot')}                                                       AS combined_bot,
    CASE
      WHEN cur.institution = 'GROOMING MFI'    THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'SHARA'           THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'KESSINGTON'      THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'REMEDIAL HEALTH' THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'KUDA'            THEN cur.daily_deposit_all * 0.3
      ELSE                                          cur.daily_deposit_all * 0.25
    END AS weekly_deposit_all,
    CASE
      WHEN cur.institution = 'GROOMING MFI'    THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'SHARA'           THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'KESSINGTON'      THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'REMEDIAL HEALTH' THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'KUDA'            THEN cur.total_value_of_lead * 0.3
      ELSE                                          cur.total_value_of_lead * 0.25
    END AS total_value_of_lead,
    cur.loan_type,
    cur.total_assigned_amount_due,
    CASE
      WHEN cur.loan_type IN (
        'SMALL LOAN', 'INDIVIDUAL LOAN FIELD', 'ASSOCIATION LOAN FIELD',
        'PAKO LOAN MONTHLY', 'MICRO LOAN', 'STATE PUBLIC SECTOR LOAN',
        'FEDERAL PUBLIC SECTOR LOAN', 'TOP-UP LOAN', 'TOP-UP  LOAN',
        'INTEREST FREE LOAN', 'GROOMING DAILY LOAN', 'FESTIVAL LOAN', 'Individual Loan'
      ) THEN 'Retail Unsecured'
      WHEN cur.loan_type = 'Business Loan'
        AND UPPER(cur.institution) IN ('REMEDIAL HEALTH', 'KESSINGTON') THEN 'SME Secured'
      WHEN cur.loan_type = 'Business Loan'
        AND UPPER(cur.institution) = 'SHARA' THEN 'SME Unsecured'
      WHEN cur.loan_type IN (
        'SME INDIVIDUAL LOAN', 'SME LOAN (INDIVIDUAL)', 'SME LOAN (GROUP)', 'SME LOAN',
        'Business Loans - above 5m', 'Business Loans -1m to 4.99m',
        'Business Loans - 500 to 999k', 'LPO Financing'
      ) THEN 'SME Unsecured'
      WHEN cur.loan_type IN (
        'ASSET LOAN GROUP', 'SOLAR LOAN', 'GREEN ENERGY LOAN', 'ASSET LOAN',
        'ASSET LOAN (INDIVIDUAL)', 'MICRO ASSET LOAN', 'Personal Loan - bankers'
      ) THEN 'Retail Secured'
      WHEN cur.loan_type IN (
        'GREEN ENERGY CORPORATE LOAN', 'SHORT - TERM AGRO-BUSINESS LOAN',
        'LONG - TERM AGRO-BUSINESS LOAN'
      ) THEN 'SME Secured'
      ELSE 'Unknown'
    END AS loan_category,
    CASE
      WHEN cur.total_assigned_amount_due < 50000   THEN 'Below 50k'
      WHEN cur.total_assigned_amount_due < 100000  THEN '50k - 99k'
      WHEN cur.total_assigned_amount_due < 250000  THEN '100k - 249k'
      WHEN cur.total_assigned_amount_due < 500000  THEN '250k - 499k'
      WHEN cur.total_assigned_amount_due < 1000000 THEN '500k - 999k'
      ELSE '1m+'
    END AS amount_category,
    CASE
      WHEN cur.max_days_in_arrears_running <= 365  THEN '0-1 Year'
      WHEN cur.max_days_in_arrears_running <= 730  THEN '1-2 Years'
      WHEN cur.max_days_in_arrears_running <= 1095 THEN '2-3 Years'
      ELSE '3+ Years'
    END AS dpd,
    ${act('cur.daily_vb_out_cost')}                                                  AS daily_vb_out_cost,
    ${act('cur.daily_sms_cost')}                                                     AS daily_sms_cost,
    ${act('cur.daily_outbound_cost')}                                                AS weekly_outbound_cost,
    cur.Max_days_in_arrears,
    cur.loan_count,
    cur.net_balance                                                                  AS final_balance,
    cur.institution,
    cur.client_id
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` AS cur
  WHERE cur.date BETWEEN DATE '${df}' AND DATE '${depositDt}'
    ${instFilter}
)
SELECT *,
  CASE
    WHEN total_assigned_amount_due > 31000 AND max_days_in_arrears > 570
      THEN 'High Amount, High Days'
    WHEN total_assigned_amount_due > 31000 AND max_days_in_arrears <= 570
      THEN 'High Amount, Low Days'
    WHEN total_assigned_amount_due <= 31000 AND max_days_in_arrears > 570
      THEN 'Low Amount, High Days'
    ELSE 'Low Amount, Low Days'
  END AS client_bucket
FROM base`.trim()
}
