import type { ReportConfig, ReportFilters } from '@/types'

// ─── All FSS institutions ─────────────────────────────────────────────────────
export const ALL_INSTITUTIONS = [
  'CREDIT DIRECT',
  'KUDA',
  'GROOMING MFI',
  'GROOMING MFB',
  'SYCAMORE MFB',
  'SHARA',
  'REMEDIAL HEALTH',
  'KESSINGTON',
  'LUKEFIELD',
  'NOLT',
  'NUMIDA',
  'VICTORY EMPOWERMENT',
  'ROSABON',
  'LAPO',
  'PEZESHA',
  'RENMONEY',
  'MAINSTREET',
  'AB MFB',
  'BAOBAB',
  'VENDEASE',
  'STERLING',
] as const

export type Institution = typeof ALL_INSTITUTIONS[number]

// ─── Loan ID expression — CREDIT DIRECT splits on '-', others use raw ─────────
export function loanIdExpr(institution: string): string {
  return (institution === 'CREDIT DIRECT' || institution === 'RENMONEY')
    ? `SPLIT(ANY_VALUE(l.loan_id), '-')[SAFE_OFFSET(0)]`
    : `ANY_VALUE(l.loan_id)`
}

// ─── Recovery Report query builder ────────────────────────────────────────────
// Archived variants are folded into their canonical institution names.
const ARCHIVED_MAP: Record<string, string> = {
  'NUMIDA':         'NUMIDA ARCHIVED',
  'REMEDIAL HEALTH': 'REMEDIAL ARCHIVED',
  'KESSINGTON':     'KESSINGTON ARCHIVED',
}

function instWhereClause(field: string, inst: string): string {
  if (!inst) return ''
  const archived = ARCHIVED_MAP[inst]
  if (archived) return `AND ${field} IN ('${inst}', '${archived}')`
  return `AND ${field} = '${inst}'`
}

// Normalises archived variants → canonical name in a SQL expression.
function normaliseInst(field: string): string {
  return `CASE
    WHEN ${field} = 'NUMIDA ARCHIVED'     THEN 'NUMIDA'
    WHEN ${field} = 'REMEDIAL ARCHIVED'   THEN 'REMEDIAL HEALTH'
    WHEN ${field} = 'KESSINGTON ARCHIVED' THEN 'KESSINGTON'
    ELSE ${field}
  END`
}

function buildRecoveryQuery(filters: ReportFilters): string {
  const inst      = filters.institution?.trim() ?? ''
  const dateFrom  = filters.dateFrom    ?? '2026-04-01'
  const dateTo    = filters.dateTo      ?? '2026-04-30'
  const loanExpr  = loanIdExpr(inst)
  const instClause = instWhereClause('d.institution', inst)

  return `
SELECT
  d.date                                                        AS date,
  d.client_id                                                   AS client_id,
  ${loanExpr}                                                   AS loan_id,
  fss_id                                                        AS fss_id,
  d.phone                                                       AS phone,
  d.email                                                       AS email,
  full_name                                                     AS full_name,
  ${normaliseInst('d.institution')}                             AS institution,
  MAX(total_assigned_amount_due)                                AS assigned_amount,
  SUM(daily_deposit_all)                                        AS amount_recovered,
  ARRAY_AGG(net_balance ORDER BY date DESC LIMIT 1)[OFFSET(0)] AS loan_balance
FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
LEFT JOIN (
  SELECT client_id, loan_id
  FROM \`fssspark.original_cohorts.all_leads\`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY loan_id) = 1
) l ON d.client_id = l.client_id
WHERE daily_deposit_all > 0
  ${instClause}
  AND date BETWEEN '${dateFrom}' AND '${dateTo}'
GROUP BY 1, 2, 4, 5, 6, 7, 8
`.trim()
}

// ─── REPORT REGISTRY ─────────────────────────────────────────────────────────
// Add new reports here — nothing else needs to change.
export const REPORT_CATEGORIES = ['Collections', 'Portfolio', 'Operations'] as const

export const REPORTS: ReportConfig[] = [
  {
    id:       'recovery_report',
    label:    'Recovery Report',
    category: 'Collections',
    tag:      'COL',
    desc:     'Payments recovered per borrower within a date range, grouped by institution',
    bqKey:    'bq_recovery_report',
    filters:  ['institution', 'dateFrom', 'dateTo'],
    buildQuery: buildRecoveryQuery,
    coreColumns: [
      { key: 'date',             label: 'Date',             type: 'date'     },
      { key: 'client_id',        label: 'Client ID',        type: 'mono'     },
      { key: 'loan_id',          label: 'Loan ID',          type: 'mono'     },
      { key: 'full_name',        label: 'Full Name',        type: 'text'     },
      { key: 'institution',      label: 'Institution',      type: 'badge'    },
      { key: 'amount_recovered', label: 'Amount Recovered', type: 'currency' },
      { key: 'assigned_amount',  label: 'Assigned Amount',  type: 'currency' },
      { key: 'loan_balance',     label: 'Current Balance',  type: 'currency' },
    ],
    extraColumns: [
      { key: 'fss_id', label: 'FSS ID', type: 'mono' },
      { key: 'phone',  label: 'Phone',  type: 'text' },
      { key: 'email',  label: 'Email',  type: 'text' },
    ],
  },
  {
    id:       'billing_report',
    label:    'Billing Report',
    category: 'Collections',
    tag:      'COL',
    desc:     'Commission-based billing summary with per-institution recovery breakdown and WHT calculation',
    bqKey:    'bq_billing_report',
    filters:  ['institution', 'dateFrom', 'dateTo'],
    coreColumns: [
      { key: 'institution',      label: 'Institution',         type: 'badge'    },
      { key: 'bucket',           label: 'Bucket',              type: 'text'     },
      { key: 'amount_recovered', label: 'Amount Recovered',    type: 'currency' },
      { key: 'revenue_pre_wht',  label: 'Revenue Pre WHT 5%',  type: 'currency' },
      { key: 'revenue_post_wht', label: 'Revenue Post WHT 5%', type: 'currency' },
    ],
    extraColumns: [
      { key: 'commission', label: 'Commission', type: 'text'     },
      { key: 'wht_5pct',   label: 'WHT 5%',     type: 'currency' },
      { key: 'start_date', label: 'Start Date', type: 'date'     },
      { key: 'end_date',   label: 'End Date',   type: 'date'     },
    ],
  },
  {
    id:       'weekly_trend_report',
    label:    'Weekly Trend Report',
    category: 'Collections',
    tag:      'COL',
    desc:     'Week-by-week recovery totals across months for the selected year',
    bqKey:    'bq_weekly_trend',
    filters:  ['institution', 'year', 'monthFrom', 'monthTo'],
    coreColumns: [],
    extraColumns: [],
  },
  {
    id:       'agent_performance',
    label:    'Agent Performance',
    category: 'Operations',
    tag:      'OPS',
    desc:     'Multi-dimensional agent rankings by recovery amount or revenue with scoring',
    bqKey:    'bq_agent_performance',
    filters:  ['dateFrom', 'dateTo'],
    coreColumns:  [],
    extraColumns: [],
  },
  {
    id:       'concession_tracker',
    label:    'Concession Tracker',
    category: 'Operations',
    tag:      'OPS',
    desc:     'Track concession offers, conversion rates, and recovery outcomes per institution',
    bqKey:    'bq_concession_tracker',
    filters:  ['institution', 'dateFrom', 'dateTo'],
    coreColumns:  [],
    extraColumns: [],
  },
  {
    id:       'activity_report',
    label:    'Activity Report',
    category: 'Operations',
    tag:      'OPS',
    desc:     'Recovery performance and contact channel activity — calls, WhatsApp, and SMS — by institution',
    bqKey:    'bq_activity_report',
    filters:  ['institution', 'dateFrom', 'dateTo'],
    coreColumns:  [],
    extraColumns: [],
  },
  {
    id:       'recovery_methods',
    label:    'Recovery Methods Report',
    category: 'Collections',
    tag:      'COL',
    desc:     'Contact method effectiveness by institution — profit, ROI and recovery rate per outreach type',
    bqKey:    'bq_recovery_methods',
    filters:  ['institution', 'dateFrom', 'dateTo'],
    coreColumns:  [],
    extraColumns: [],
  },
]
export function getReport(id: string): ReportConfig | undefined {
  return REPORTS.find(r => r.id === id)
}

export function getReportsByCategory(): Record<string, ReportConfig[]> {
  const grouped = REPORT_CATEGORIES.reduce((acc, category) => {
    acc[category] = []
    return acc
  }, {} as Record<string, ReportConfig[]>)

  for (const report of REPORTS) {
    if (!grouped[report.category]) grouped[report.category] = []
    grouped[report.category].push(report)
  }

  return grouped
}

