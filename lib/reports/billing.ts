import type { ColumnDef } from '@/types'

// ─── Institution rule sets (client-safe, used for column building) ─────────────
export const NO_LOAN_ID   = new Set([
  'REMEDIAL HEALTH', 'KESSINGTON', 'GROOMING MFI', 'SHARA', 'VICTORY EMPOWERMENT',
])
export const NO_CLIENT_ID = new Set(['KUDA'])
export const NO_BALANCE   = new Set(['GROOMING MFI'])

// ─── Column definitions per institution ──────────────────────────────────────
export function getBillingDetailColumns(inst: string): ColumnDef[] {
  const isCreditDirect = inst === 'CREDIT DIRECT'
  const isKuda         = inst === 'KUDA'
  const needsLoan      = !NO_LOAN_ID.has(inst)
  const needsClient    = !NO_CLIENT_ID.has(inst)
  const needsBalance   = !NO_BALANCE.has(inst)

  const cols: ColumnDef[] = []

  cols.push({ key: 'Date', label: 'Date', type: 'date' })

  if (needsClient) {
    cols.push({ key: 'Client ID', label: 'Client ID', type: 'mono' })
  }

  if (needsLoan) {
    const loanLabel = isKuda ? 'Account Number' : 'Loan ID'
    cols.push({ key: loanLabel, label: loanLabel, type: 'mono' })
  }

  cols.push({ key: 'FSS ID', label: 'FSS ID', type: 'mono' })
  cols.push({ key: 'Phone',  label: 'Phone',  type: 'text' })
  cols.push({ key: 'Email',  label: 'Email',  type: 'text' })

  if (isCreditDirect) {
    cols.push({ key: 'First Name',   label: 'First Name',   type: 'text' })
    cols.push({ key: 'Last Name',    label: 'Last Name',    type: 'text' })
    cols.push({ key: 'Middle Name',  label: 'Middle Name',  type: 'text' })
    cols.push({ key: 'Product',      label: 'Product',      type: 'text' })
    cols.push({ key: 'Payment Mode', label: 'Payment Mode', type: 'text' })
  } else {
    cols.push({ key: 'Full Name', label: 'Full Name', type: 'text' })
  }

  const ccy = (inst === 'NUMIDA' || inst === 'PEZESHA') ? ' (KSh)' : ''
  cols.push({ key: 'Assigned Amount',  label: `Assigned Amount${ccy}`,  type: 'currency' })
  cols.push({ key: 'Amount Recovered', label: `Amount Recovered${ccy}`, type: 'currency' })

  if (needsBalance) {
    cols.push({ key: 'Current Loan Balance', label: `Current Loan Balance${ccy}`, type: 'currency' })
  }

  if (isCreditDirect) {
    cols.push({ key: 'EDC', label: 'EDC', type: 'text' })
  }

  return cols
}

// ─── Summary column definitions ───────────────────────────────────────────────
export const BILLING_SUMMARY_CORE_COLUMNS: ColumnDef[] = [
  { key: 'institution',      label: 'Institution',         type: 'badge'    },
  { key: 'bucket',           label: 'Bucket',              type: 'text'     },
  { key: 'amount_recovered', label: 'Amount Recovered',    type: 'currency' },
  { key: 'revenue_pre_wht',  label: 'Revenue Pre WHT 5%',  type: 'currency' },
  { key: 'revenue_post_wht', label: 'Revenue Post WHT 5%', type: 'currency' },
]

export const BILLING_SUMMARY_EXTRA_COLUMNS: ColumnDef[] = [
  { key: 'commission', label: 'Commission', type: 'text'     },
  { key: 'wht_5pct',   label: 'WHT 5%',     type: 'currency' },
  { key: 'start_date', label: 'Start Date', type: 'date'     },
  { key: 'end_date',   label: 'End Date',   type: 'date'     },
]

export const ALL_BILLING_SUMMARY_COLUMNS: ColumnDef[] = [
  { key: 'start_date',       label: 'Start Date',          type: 'date'     },
  { key: 'end_date',         label: 'End Date',            type: 'date'     },
  { key: 'institution',      label: 'Institution',         type: 'badge'    },
  { key: 'bucket',           label: 'Bucket',              type: 'text'     },
  { key: 'amount_recovered', label: 'Amount Recovered',    type: 'currency' },
  { key: 'commission',       label: 'Commission',          type: 'text'     },
  { key: 'revenue_pre_wht',  label: 'Revenue Pre WHT 5%',  type: 'currency' },
  { key: 'wht_5pct',         label: 'WHT 5%',              type: 'currency' },
  { key: 'revenue_post_wht', label: 'Revenue Post WHT 5%', type: 'currency' },
]