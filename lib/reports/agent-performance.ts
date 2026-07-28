// Client-safe constants for the Agent Performance report.
import type { ColumnDef } from '@/types'

export type AgentMode = 'recoveries' | 'revenue' | 'normalized_recovery'

// ── Scoring constants ─────────────────────────────────────────────────────────
// Single source of truth for the scoring formula — imported by the (server-only)
// BigQuery builder in agent-performance.queries.ts AND usable client-side (e.g.
// the what-if simulator), so the two can never drift out of sync.
//
// Fixed, portfolio-size-independent daily activity targets — team-wide all-time
// average daily calls/WhatsApp/distinct-customers-reached (per active day),
// doubled. Replaces the old "your volume ÷ team total volume" formula, which
// unfairly rewarded whichever channel the team collectively used less, and
// unfairly disadvantaged agents with very large portfolios who can't
// realistically contact everyone.
export const CALL_TARGET_PER_DAY  = 115.93464810672052
export const WA_TARGET_PER_DAY    = 18.566815823252959
export const REACH_TARGET_PER_DAY = 66.01437556154538

// Top-level weights for the four scoring dimensions. Conversion and Amount are
// weighted lower than Contact and PTP because both depend on deposit data,
// which sometimes posts late — making rank comparisons on those two
// dimensions noisier than the other two, which don't have that lag.
export const WEIGHT_CONTACT    = 0.25
export const WEIGHT_PTP        = 0.30
export const WEIGHT_CONVERSION = 0.25
export const WEIGHT_AMOUNT     = 0.20

// Always visible
export const AGENT_CORE_COLUMNS: ColumnDef[] = [
  { key: 'agent',               label: 'Agent',               type: 'text'     },
  { key: 'overall_rank',        label: 'Rank',                type: 'num'      },
  { key: 'total_amount',        label: 'Amount',              type: 'currency' },
  { key: 'total_calls',         label: 'Calls',               type: 'num'      },
  { key: 'total_ptp',           label: 'PTPs',                type: 'num'      },
  { key: 'conversion_rate',     label: 'Conv. Rate',          type: 'num'      },
  { key: 'customers_contacted', label: 'Customers Contacted', type: 'num'      },
  { key: 'weighted_score',      label: 'Weighted Score',      type: 'num'      },
]

// User-toggleable
export const AGENT_EXTRA_COLUMNS: ColumnDef[] = [
  { key: 'total_whatsapp',      label: 'WhatsApp Contacts',   type: 'num' },
  { key: 'call_target',         label: 'Call Target',         type: 'num' },
  { key: 'wa_target',           label: 'WhatsApp Target',     type: 'num' },
  { key: 'total_reach_days',    label: 'Reach (Contact-Days)',type: 'num' },
  { key: 'reach_target',        label: 'Reach Target',        type: 'num' },
  { key: 'reach_attainment',    label: 'Reach Attainment',    type: 'num' },
  { key: 'total_converted',     label: 'Converted PTPs',      type: 'num' },
  { key: 'contact_attainment',  label: 'Contact Attainment',  type: 'num' },
  { key: 'ptp_rate',            label: 'PTP Rate',            type: 'num' },
  { key: 'recovery_rate',       label: 'Recovery Rate',       type: 'num' },
  { key: 'amount_assigned',     label: 'Amount Assigned',     type: 'currency' },
  { key: 'ptp_rate_rank',            label: 'PTP Rate Rank',            type: 'num' },
  { key: 'ptp_volume_rank',          label: 'PTP Volume Rank',          type: 'num' },
  { key: 'conversion_rate_rank',     label: 'Conv. Rate Rank',          type: 'num' },
  { key: 'conversion_volume_rank',   label: 'Conv. Volume Rank',        type: 'num' },
  { key: 'amount_rate_rank',         label: 'Recovery Rate Rank',       type: 'num' },
  { key: 'amount_volume_rank',       label: 'Amount Volume Rank',       type: 'num' },
  { key: 'contact_rank',             label: 'Combined Contact Rank',     type: 'num' },
  { key: 'ptp_rank',                 label: 'Combined PTP Rank',         type: 'num' },
  { key: 'conversion_rank',          label: 'Combined Conversion Rank',  type: 'num' },
  { key: 'amount_rank',              label: 'Combined Amount Rank',      type: 'num' },
]
