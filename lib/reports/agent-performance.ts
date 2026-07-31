// Client-safe constants for the Agent Performance report.
import type { ColumnDef } from '@/types'

// ── Scoring constants ─────────────────────────────────────────────────────────
// Single source of truth for the scoring formula — imported by the (server-only)
// BigQuery builder in agent-performance.queries.ts AND usable client-side (e.g.
// the what-if simulator), so the two can never drift out of sync.
//
// Fixed, portfolio-size-independent daily activity targets — team-wide all-time
// average daily calls/WhatsApp/distinct-customers-reached (per active day).
// Replaces the old "your volume ÷ team total volume" formula, which unfairly
// rewarded whichever channel the team collectively used less, and unfairly
// disadvantaged agents with very large portfolios who can't realistically
// contact everyone.
// Calls/WhatsApp are the team-wide average doubled; Reach is tripled (a
// deliberately higher bar for breadth of unique contact specifically).
export const CALL_TARGET_PER_DAY  = 115.93464810672052   // 57.967324053360258 × 2
export const WA_TARGET_PER_DAY    = 18.566815823252959   // 9.28340791162648   × 2
export const REACH_TARGET_PER_DAY = 99.02156334231807    // 33.00718778077269  × 3

// Top-level weights for the four scoring dimensions — tuned iteratively.
// PTP currently carries 0% weight — it has no dimension score of its own
// (see agent-performance.queries.ts), only participating in scoring via
// total_ptp/total_converted feeding the Conversion dimension.
export const WEIGHT_CONTACT    = 0.4
export const WEIGHT_PTP        = 0.0
export const WEIGHT_CONVERSION = 0.3
export const WEIGHT_AMOUNT     = 0.3

// Always visible
export const AGENT_CORE_COLUMNS: ColumnDef[] = [
  { key: 'agent',                  label: 'Agent',               type: 'text' },
  { key: 'overall_rank',           label: 'Rank',                type: 'num'  },
  { key: 'total_normalized_value', label: 'Normalized Score',    type: 'num'  },
  { key: 'total_calls',            label: 'Calls',               type: 'num'  },
  { key: 'total_ptp',              label: 'PTPs',                type: 'num'  },
  { key: 'conversion_rate',        label: 'Conv. Rate',          type: 'num'  },
  { key: 'customers_contacted',    label: 'Customers Contacted', type: 'num'  },
  { key: 'weighted_score',         label: 'Weighted Score',      type: 'num'  },
]

// User-toggleable
export const AGENT_EXTRA_COLUMNS: ColumnDef[] = [
  { key: 'total_amount_recovered',   label: 'Amount Recovered',         type: 'currency' },
  { key: 'total_revenue',            label: 'Revenue',                  type: 'currency' },
  { key: 'total_whatsapp',           label: 'WhatsApp Contacts',        type: 'num' },
  { key: 'call_target',              label: 'Call Target',              type: 'num' },
  { key: 'wa_target',                label: 'WhatsApp Target',          type: 'num' },
  { key: 'reach_daily_avg',          label: 'Daily Reach (avg)',        type: 'num' },
  { key: 'reach_target',             label: 'Reach Target (Daily)',     type: 'num' },
  { key: 'reach_attainment',         label: 'Reach Attainment',         type: 'num' },
  { key: 'total_converted',          label: 'Converted PTPs',           type: 'num' },
  { key: 'contact_attainment',       label: 'Contact Attainment',       type: 'num' },
  { key: 'recovery_rate',            label: 'Recovery Rate',            type: 'num' },
  { key: 'amount_assigned',          label: 'Amount Assigned',          type: 'currency' },
  { key: 'conversion_rate_rank',     label: 'Conv. Rate Rank',          type: 'num' },
  { key: 'conversion_volume_rank',   label: 'Conv. Volume Rank',        type: 'num' },
  { key: 'amount_volume_rank',       label: 'Amount Volume Rank',       type: 'num' },
  { key: 'contact_rank',             label: 'Combined Contact Rank',    type: 'num' },
  { key: 'conversion_rank',          label: 'Combined Conversion Rank', type: 'num' },
  { key: 'amount_rank',              label: 'Combined Amount Rank',     type: 'num' },
]
