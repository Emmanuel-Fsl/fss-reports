// SERVER-ONLY — never imported by client components.
import {
  CALL_TARGET_PER_DAY, WA_TARGET_PER_DAY, REACH_TARGET_PER_DAY,
  WEIGHT_CONTACT, WEIGHT_PTP, WEIGHT_CONVERSION, WEIGHT_AMOUNT,
} from './agent-performance'

export interface AgentPerfFilters {
  dateFrom:              string
  dateTo:                string
  includedInstitutions?: string[]   // revenue mode only — empty = all
}

// FX rate query — returns 1 row: { ngn_per_unit: number }
// ngn_per_unit means: 1 KES = ngn_per_unit NGN
// So: amount_kes * ngn_per_unit = amount_ngn
export function buildFxRateQuery(): string {
  return `
    SELECT ngn_per_unit
    FROM \`fssspark.recovery_methods_data.currency_conversion_rates\`
    WHERE currency_code = 'KES'
    QUALIFY ROW_NUMBER() OVER (ORDER BY rate_date DESC) = 1
  `.trim()
}

// Archived variants that are folded into their canonical institution name.
// Selecting "NUMIDA" should also pull in "NUMIDA ARCHIVED", etc.
const ARCHIVED_VARIANTS: Record<string, string> = {
  'NUMIDA':          'NUMIDA ARCHIVED',
  'REMEDIAL HEALTH': 'REMEDIAL ARCHIVED',
  'KESSINGTON':      'KESSINGTON ARCHIVED',
}

// Build an SQL WHERE fragment that expands archived variants automatically.
// Returns '' when no filter is needed (all / none selected).
function buildInstFilter(includedInstitutions?: string[]): string {
  if (!includedInstitutions?.length) return ''
  const expanded = new Set<string>()
  for (const inst of includedInstitutions) {
    expanded.add(inst)
    if (ARCHIVED_VARIANTS[inst]) expanded.add(ARCHIVED_VARIANTS[inst])
  }
  return `AND institution IN (${[...expanded].map(i => `'${i}'`).join(', ')})`
}

// Shared date-bound CTEs used by both queries.
// All PTP logic lives here and resolves to a single ptp_summary CTE;
// per-agent CTEs are completely PTP-free.
function sharedCtePrologue(df: string, dt: string, instFilter: string): string {
  return `
-- NULL ptp_date is auto-filled with the report end date so every PTP has a window
-- and no PTP is silently excluded from conversion checks.
ptp_base AS (
  SELECT
    phone,
    institution,
    LOWER(TRIM(agent)) AS agent,
    DATE(date) AS contact_date,
    COALESCE(ptp_date, DATE('${dt}')) AS ptp_date,
    -- Flag real ptp_dates so they get conversion priority over null-filled ones
    (ptp_date IS NOT NULL) AS has_real_ptp_date,
    -- NULL ptp_dates use the report end date with no grace period;
    -- real ptp_dates get the standard 3-day grace period.
    CASE
      WHEN ptp_date IS NULL
        THEN DATE('${dt}')
      ELSE DATE_ADD(ptp_date, INTERVAL 3 DAY)
    END AS window_end
  FROM \`fssspark.recovery_methods_data.call_notes\`
  WHERE DATE(date) BETWEEN '${df}' AND '${dt}'
    AND UPPER(TRIM(Promise_to_Pay)) = 'YES'
    ${instFilter}
),

-- One record per (phone, institution, ptp_date) — earliest contact wins ties
ptp_distinct AS (
  SELECT
    phone,
    institution,
    agent,
    contact_date,
    ptp_date,
    has_real_ptp_date,
    window_end,
    ROW_NUMBER() OVER (
      PARTITION BY phone, institution, ptp_date
      ORDER BY contact_date ASC, agent ASC
    ) AS rn_same_date
  FROM ptp_base
),

ptp_unique AS (
  SELECT
    phone,
    institution,
    agent,
    contact_date,
    ptp_date,
    has_real_ptp_date,
    window_end,
    ROW_NUMBER() OVER (
      PARTITION BY phone, institution
      ORDER BY contact_date ASC, agent ASC
    ) AS rn_asc,
    ROW_NUMBER() OVER (
      PARTITION BY phone, institution
      ORDER BY contact_date DESC, agent ASC
    ) AS rn_desc,
    COUNT(*) OVER (
      PARTITION BY phone, institution
    ) AS total_ptps
  FROM ptp_distinct
  WHERE rn_same_date = 1
),

-- Payments up to 3 days past period end to cover full PTP windows
payments AS (
  SELECT
    phone,
    institution,
    DATE(date) AS payment_date,
    SUM(daily_deposit_all_op) AS daily_total
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  WHERE daily_deposit_all_op > 0
    AND DATE(date) BETWEEN '${df}' AND DATE_ADD('${dt}', INTERVAL 3 DAY)
    ${instFilter}
  GROUP BY phone, institution, DATE(date)
),

-- Check if a payment landed within each agent's PTP window (contact → window_end)
agent_conversion AS (
  SELECT
    p.phone,
    p.institution,
    p.agent,
    p.contact_date,
    p.ptp_date,
    p.has_real_ptp_date,
    p.window_end,
    p.rn_asc,
    p.rn_desc,
    p.total_ptps,
    MAX(
      CASE
        WHEN pay.payment_date BETWEEN p.contact_date AND p.window_end
          THEN 1
        ELSE 0
      END
    ) AS converted,
    MIN(
      CASE
        WHEN pay.payment_date BETWEEN p.contact_date AND p.window_end
          THEN pay.payment_date
        ELSE NULL
      END
    ) AS first_payment_date
  FROM ptp_unique p
  LEFT JOIN payments pay
    ON pay.phone = p.phone
    AND pay.institution = p.institution
  GROUP BY
    p.phone, p.institution, p.agent,
    p.contact_date, p.ptp_date, p.has_real_ptp_date, p.window_end,
    p.rn_asc, p.rn_desc, p.total_ptps
),

final_assignment AS (
  SELECT
    phone,
    institution,
    agent,
    contact_date,
    ptp_date,
    has_real_ptp_date,
    window_end,
    converted,
    first_payment_date,
    total_ptps,
    rn_asc,
    rn_desc,
    -- Priority: real ptp_date + converted > null ptp_date + converted > not converted
    ROW_NUMBER() OVER (
      PARTITION BY phone, institution
      ORDER BY
        CASE
          WHEN has_real_ptp_date AND converted = 1     THEN 1
          WHEN NOT has_real_ptp_date AND converted = 1 THEN 2
          ELSE 3
        END ASC,
        first_payment_date ASC,
        agent ASC
    ) AS rn_converted_first,
    -- Window MAX replaces the old NOT EXISTS correlated subquery
    MAX(converted) OVER (PARTITION BY phone, institution) AS any_converted
  FROM agent_conversion
),

ptp_awarded AS (
  SELECT
    phone,
    institution,
    agent,
    contact_date,
    ptp_date,
    window_end,
    converted,
    CASE
      WHEN total_ptps = 1                          THEN TRUE
      WHEN rn_converted_first = 1 AND converted = 1 THEN TRUE
      WHEN any_converted = 0 AND rn_desc = 1        THEN TRUE
      ELSE FALSE
    END AS is_awarded
  FROM final_assignment
),

-- Individual awarded records — used for payment attribution in both query modes
ptp_awarded_records AS (
  SELECT phone, institution, agent, contact_date, ptp_date, window_end, converted
  FROM ptp_awarded
  WHERE is_awarded = TRUE
),

-- Per payment: rank all agents whose PTP windows cover it.
-- If one payment falls in two overlapping windows, only the winner (earliest contact, then alpha) is credited.
payment_window_match AS (
  SELECT
    pay.phone,
    pay.institution,
    pay.payment_date,
    pu.agent,
    pu.ptp_date,
    pu.window_end,
    ROW_NUMBER() OVER (
      PARTITION BY pay.phone, pay.institution, pay.payment_date
      ORDER BY pu.has_real_ptp_date DESC, pu.contact_date ASC, pu.agent ASC
    ) AS payment_rn
  FROM payments pay
  JOIN ptp_unique pu
    ON  pay.phone       = pu.phone
    AND pay.institution = pu.institution
    AND pay.payment_date BETWEEN pu.contact_date AND pu.window_end
),

-- A PTP converts only if this agent won the ranking for at least one payment in their window.
-- Different payments in non-overlapping windows each count independently.
ptp_conversion AS (
  SELECT agent, phone, institution, ptp_date,
    MAX(CASE WHEN payment_rn = 1 THEN 1 ELSE 0 END) AS converted
  FROM payment_window_match
  GROUP BY agent, phone, institution, ptp_date
),

-- All closed PTPs; zero-fill agents whose windows closed with no payment
ptp_with_conversion AS (
  SELECT
    pu.agent,
    COALESCE(pc.converted, 0) AS converted
  FROM ptp_unique pu
  LEFT JOIN ptp_conversion pc
    ON  pc.agent       = pu.agent
    AND pc.phone       = pu.phone
    AND pc.institution = pu.institution
    AND pc.ptp_date    = pu.ptp_date
  WHERE pu.window_end <= DATE('${dt}')
),

-- One row per agent
ptp_summary AS (
  SELECT
    agent,
    COUNT(*)                              AS total_ptps,
    SUM(converted)                        AS total_converted,
    SAFE_DIVIDE(SUM(converted), COUNT(*)) AS ptp_conv_rate
  FROM ptp_with_conversion
  GROUP BY agent
),

conversion_rate AS (
  SELECT ngn_per_unit
  FROM \`fssspark.recovery_methods_data.currency_conversion_rates\`
  WHERE currency_code = 'KES'
  QUALIFY ROW_NUMBER() OVER (ORDER BY rate_date DESC) = 1
)`
}

// Builds the payment attribution CTEs for the recoveries query.
// Priority: (1) PTP agent whose window covers the payment, earliest contact wins.
//           (2) Last agent to contact the client on or before the payment date.
//           (3) Alphabetically first agent name on a same-day tie.
// normalized=true: agent_recoveries sums (deposit / total_value_of_lead) ratios instead of raw NGN amounts.
function buildRecoveryAttributionCtes(df: string, dt: string, instFilter: string, normalized = false): string {
  const contactUnion = AGENTS.map(a => `
  SELECT client_id, phone, institution, date, '${a.lower}' AS agent
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  WHERE date BETWEEN '${df}' AND '${dt}'
    AND (${a.lower}_call > 0 OR ${a.lower}_call_inbound > 0 OR ${a.lower}_call_logged > 0 OR ${a.lower}_whatsapp > 0)
    ${instFilter}`).join('\n  UNION ALL')

  return `
-- One row per (client, institution, date, agent) where that agent had any contact activity
contact_log AS (${contactUnion}
),

-- All payment rows in the period
payments_in_period AS (
  SELECT
    client_id,
    phone,
    date AS payment_date,
    institution,
    daily_deposit_all_op
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
  WHERE daily_deposit_all_op > 0
    AND date BETWEEN '${df}' AND '${dt}'
    ${instFilter}
),

-- Rank all contacts on or before each payment date (most recent first, alphabet tiebreaker)
payment_contact_ranked AS (
  SELECT
    p.client_id,
    p.phone,
    p.payment_date,
    p.institution,
    p.daily_deposit_all_op,
    cl.agent AS last_touch_agent,
    ROW_NUMBER() OVER (
      PARTITION BY p.client_id, p.phone, p.institution, p.payment_date
      ORDER BY cl.date DESC, cl.agent ASC
    ) AS rn
  FROM payments_in_period p
  LEFT JOIN contact_log cl
    ON  cl.client_id   = p.client_id
    AND cl.phone       = p.phone
    AND cl.institution = p.institution
    AND cl.date        <= p.payment_date
),

-- Keep only the top-ranked (most recent) contact per payment
payment_with_last_touch AS (
  SELECT client_id, phone, payment_date, institution, daily_deposit_all_op, last_touch_agent
  FROM payment_contact_ranked
  WHERE rn = 1
),

-- Rank any PTP windows covering each payment (earliest contact_date wins)
payment_ptp_ranked AS (
  SELECT
    p.*,
    par.agent AS ptp_agent,
    ROW_NUMBER() OVER (
      PARTITION BY p.client_id, p.phone, p.institution, p.payment_date
      ORDER BY par.contact_date ASC, par.agent ASC
    ) AS rn
  FROM payment_with_last_touch p
  LEFT JOIN ptp_awarded_records par
    ON  par.phone        = p.phone
    AND par.institution  = p.institution
    AND p.payment_date BETWEEN par.contact_date AND par.window_end
),

-- PTP agent takes priority over last touch; keep one row per payment
payment_attribution AS (
  SELECT
    client_id,
    phone,
    payment_date,
    institution,
    daily_deposit_all_op,
    COALESCE(ptp_agent, last_touch_agent) AS attributed_agent
  FROM payment_ptp_ranked
  WHERE rn = 1
),

-- Sum attributed payments per agent
agent_recoveries AS (${normalized ? `
  -- Normalized: sum(deposit / lead_value) per attributed payment.
  -- total_value_of_lead is constant per customer so we take MAX to get one row
  -- per (client_id, phone, institution) — avoids any fan-out from the date join.
  SELECT
    pa.attributed_agent AS agent,
    SUM(SAFE_DIVIDE(pa.daily_deposit_all_op, lead_vals.tvol)) AS total_amount
  FROM payment_attribution pa
  LEFT JOIN (
    SELECT client_id, phone, institution, MAX(total_value_of_lead) AS tvol
    FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\`
    GROUP BY client_id, phone, institution
  ) lead_vals
    ON  lead_vals.client_id   = pa.client_id
    AND lead_vals.phone       = pa.phone
    AND lead_vals.institution = pa.institution
  WHERE pa.attributed_agent IS NOT NULL
  GROUP BY pa.attributed_agent` : `
  -- Raw NGN amounts with KES→NGN FX conversion for Kenya institutions
  SELECT
    attributed_agent AS agent,
    SUM(CASE
      WHEN institution IN ('NUMIDA', 'NUMIDA ARCHIVED', 'PEZESHA')
        THEN daily_deposit_all_op * fx.ngn_per_unit
      ELSE daily_deposit_all_op
    END) AS total_amount
  FROM payment_attribution
  CROSS JOIN conversion_rate fx
  WHERE attributed_agent IS NOT NULL
  GROUP BY attributed_agent`}
)`
}

// Generates the per-agent metric CTE for the recoveries query.
// total_amount is a scalar pull from agent_recoveries (full attribution logic).
// Calls, whatsapp, customers_contacted are aggregated directly from the raw table.
function recoveryAgentCtePair(lname: string, df: string, dt: string, instFilter: string): string {
  const lc = lname.toLowerCase()
  return `
${lc}_metrics AS (
  SELECT
    SUM(CASE
      WHEN d.${lc}_call > 0 OR d.${lc}_call_inbound > 0
        THEN d.${lc}_call + d.${lc}_call_inbound
      ELSE d.${lc}_call_logged
    END)                   AS total_calls,
    SUM(d.${lc}_whatsapp)  AS total_whatsapp,
    (SELECT COALESCE(ar.total_amount, 0) FROM agent_recoveries ar WHERE ar.agent = '${lc}') AS total_amount,
    COUNT(DISTINCT CASE
      WHEN d.${lc}_call > 0 OR d.${lc}_call_inbound > 0 OR d.${lc}_call_logged > 0 OR d.${lc}_whatsapp > 0
        THEN d.client_id
    END)                   AS customers_contacted,
    -- Portfolio value of clients this agent contacted — denominator for recovery_rate.
    (SELECT COALESCE(SUM(t.assigned), 0) FROM (
      SELECT client_id, MAX(total_assigned_amount_due) AS assigned
      FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d2
      WHERE d2.date BETWEEN '${df}' AND '${dt}'
        ${instFilter}
        AND (d2.${lc}_call > 0 OR d2.${lc}_call_inbound > 0 OR d2.${lc}_call_logged > 0 OR d2.${lc}_whatsapp > 0)
      GROUP BY client_id
    ) t)                   AS amount_assigned,
    -- Sum of distinct-clients-contacted-per-day (a client contacted on 2
    -- different days counts twice) — denominator match for REACH_TARGET_PER_DAY,
    -- kept separate from customers_contacted (a period-level unique headcount).
    (SELECT SUM(daily_reach) FROM (
      SELECT COUNT(DISTINCT CASE
        WHEN d3.${lc}_call > 0 OR d3.${lc}_call_inbound > 0 OR d3.${lc}_call_logged > 0 OR d3.${lc}_whatsapp > 0
          THEN d3.client_id
      END) AS daily_reach
      FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d3
      WHERE d3.date BETWEEN '${df}' AND '${dt}'
        ${instFilter}
      GROUP BY d3.date
    ))                     AS total_reach_days
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
  WHERE d.date BETWEEN '${df}' AND '${dt}'
    ${instFilter}
)`
}

// Builds the payment attribution CTEs for the revenue query.
// Same last-touch + PTP-priority logic as recovery, but uses revenue_base
// (which already has daily_revenue = deposit × profit_rate × FX) as the payment source.
function buildRevenueAttributionCtes(_df: string, _dt: string, _instFilter: string): string {
  const contactUnion = AGENTS.map(a => `
  SELECT client_id, phone, institution, date, '${a.lower}' AS agent
  FROM revenue_base
  WHERE ${a.lower}_call > 0 OR ${a.lower}_call_inbound > 0 OR ${a.lower}_call_logged > 0 OR ${a.lower}_whatsapp > 0`).join('\n  UNION ALL')

  return `
-- One row per (client, institution, date, agent) where that agent had any contact activity
rev_contact_log AS (${contactUnion}
),

-- All payment rows in the period (daily_revenue already includes FX + profit rate)
rev_payments_in_period AS (
  SELECT
    client_id,
    phone,
    date AS payment_date,
    institution,
    daily_revenue AS payment_amount
  FROM revenue_base
  WHERE daily_revenue > 0
),

-- Rank all contacts on or before each payment date (most recent first, alphabet tiebreaker)
rev_payment_contact_ranked AS (
  SELECT
    p.client_id,
    p.phone,
    p.payment_date,
    p.institution,
    p.payment_amount,
    cl.agent AS last_touch_agent,
    ROW_NUMBER() OVER (
      PARTITION BY p.client_id, p.phone, p.institution, p.payment_date
      ORDER BY cl.date DESC, cl.agent ASC
    ) AS rn
  FROM rev_payments_in_period p
  LEFT JOIN rev_contact_log cl
    ON  cl.client_id   = p.client_id
    AND cl.phone       = p.phone
    AND cl.institution = p.institution
    AND cl.date        <= p.payment_date
),

-- Keep only the top-ranked (most recent) contact per payment
rev_payment_with_last_touch AS (
  SELECT client_id, phone, payment_date, institution, payment_amount, last_touch_agent
  FROM rev_payment_contact_ranked
  WHERE rn = 1
),

-- Rank any PTP windows covering each payment (earliest contact_date wins)
rev_payment_ptp_ranked AS (
  SELECT
    p.*,
    par.agent AS ptp_agent,
    ROW_NUMBER() OVER (
      PARTITION BY p.client_id, p.phone, p.institution, p.payment_date
      ORDER BY par.contact_date ASC, par.agent ASC
    ) AS rn
  FROM rev_payment_with_last_touch p
  LEFT JOIN ptp_awarded_records par
    ON  par.phone        = p.phone
    AND par.institution  = p.institution
    AND p.payment_date BETWEEN par.contact_date AND par.window_end
),

-- PTP agent takes priority over last touch; keep one row per payment
rev_payment_attribution AS (
  SELECT
    client_id,
    phone,
    payment_date,
    institution,
    payment_amount,
    COALESCE(ptp_agent, last_touch_agent) AS attributed_agent
  FROM rev_payment_ptp_ranked
  WHERE rn = 1
),

-- Sum attributed revenue per agent (FX + profit rate already baked into payment_amount)
rev_agent_recoveries AS (
  SELECT
    attributed_agent AS agent,
    SUM(payment_amount) AS total_amount
  FROM rev_payment_attribution
  WHERE attributed_agent IS NOT NULL
  GROUP BY attributed_agent
)`
}

// Generates the per-agent metric CTE for the revenue query.
// total_amount is a scalar pull from rev_agent_recoveries (full attribution logic).
// Calls, whatsapp, customers_contacted are aggregated directly from revenue_base.
function revenueAgentCtePair(lname: string): string {
  const lc = lname.toLowerCase()
  return `
${lc}_metrics AS (
  SELECT
    SUM(CASE
      WHEN d.${lc}_call > 0 OR d.${lc}_call_inbound > 0
        THEN d.${lc}_call + d.${lc}_call_inbound
      ELSE d.${lc}_call_logged
    END)                   AS total_calls,
    SUM(d.${lc}_whatsapp)  AS total_whatsapp,
    (SELECT COALESCE(ar.total_amount, 0) FROM rev_agent_recoveries ar WHERE ar.agent = '${lc}') AS total_amount,
    COUNT(DISTINCT CASE
      WHEN d.${lc}_call > 0 OR d.${lc}_call_inbound > 0 OR d.${lc}_call_logged > 0 OR d.${lc}_whatsapp > 0
        THEN d.client_id
    END)                   AS customers_contacted,
    -- Portfolio value of clients this agent contacted — denominator for recovery_rate.
    (SELECT COALESCE(SUM(t.assigned), 0) FROM (
      SELECT client_id, MAX(total_assigned_amount_due) AS assigned
      FROM revenue_base d2
      WHERE d2.${lc}_call > 0 OR d2.${lc}_call_inbound > 0 OR d2.${lc}_call_logged > 0 OR d2.${lc}_whatsapp > 0
      GROUP BY client_id
    ) t)                   AS amount_assigned,
    -- Sum of distinct-clients-contacted-per-day (a client contacted on 2
    -- different days counts twice) — denominator match for REACH_TARGET_PER_DAY,
    -- kept separate from customers_contacted (a period-level unique headcount).
    (SELECT SUM(daily_reach) FROM (
      SELECT COUNT(DISTINCT CASE
        WHEN d3.${lc}_call > 0 OR d3.${lc}_call_inbound > 0 OR d3.${lc}_call_logged > 0 OR d3.${lc}_whatsapp > 0
          THEN d3.client_id
      END) AS daily_reach
      FROM revenue_base d3
      GROUP BY d3.date
    ))                     AS total_reach_days
  FROM revenue_base d
)`
}

const AGENTS: Array<{ display: string; lower: string }> = [
  { display: 'Kesta',      lower: 'kesta'      },
  { display: 'Dami',       lower: 'dami'       },
  { display: 'Gbolade',    lower: 'gbolade'    },
  { display: 'Diana',      lower: 'diana'      },
  { display: 'Jedidah',    lower: 'jedidah'    },
  { display: 'Emmanuella', lower: 'emmanuella' },
  { display: 'Itoro',      lower: 'itoro'      },
]

const N = AGENTS.length  // 7

// ── Scoring redesign ────────────────────────────────────────────────────────
// Scoring constants (targets + weights) live in the client-safe
// agent-performance.ts so they're shared with the what-if simulator — see
// that file for the derivation notes.

// Working days (Mon-Fri) between df and dt inclusive — used to scale the
// per-day contact targets to the report's actual period length.
function workingDaysExpr(df: string, dt: string): string {
  return `(SELECT COUNT(*) FROM UNNEST(GENERATE_DATE_ARRAY(DATE('${df}'), DATE('${dt}'))) AS wd WHERE EXTRACT(DAYOFWEEK FROM wd) NOT IN (1, 7))`
}

// Final SELECT + scoring — same for both modes.
// ptp_summary (built in sharedCtePrologue) is joined here by agent name.
//
// Scoring redesign: each of the three funnel dimensions (PTP, Conversion,
// Amount) blends a RATE (skill/efficiency — RANK-based, since "what's a good
// rate" is inherently relative to peers) with its raw VOLUME counterpart
// (RANK-based too), 50/50. This means a tiny, easily-perfected sample (e.g.
// 8 PTPs, all 8 paid) can't top the leaderboard on rate alone — its low
// volume-rank holds it back — and a huge-portfolio agent with a mediocre
// rate can't top it on volume alone either. Contact (calls/WhatsApp) is
// different: it's an EFFORT metric an agent can just decide to do more of,
// so it gets a fixed, achievable TARGET-ATTAINMENT score instead of ranking
// against peers or a shifting team total.
// amountAlreadyNormalized: true for the normalized_recovery mode, where
// total_amount is already a per-customer-normalized (deposit ÷ lead value)
// efficiency score rather than raw currency. Dividing that by amount_assigned
// (always raw currency) would mix units and produce a meaningless rate, so in
// that mode we skip the rate half entirely and score Amount on its volume
// rank alone — total_amount there is already "normalized", just upstream of
// this scoring step instead of inside it.
function finalSelect(df: string, dt: string, amountAlreadyNormalized = false): string {
  const unionAll = AGENTS.map(a =>
    `SELECT '${a.display}' AS agent, m.* FROM ${a.lower}_metrics m`
  ).join('\nUNION ALL\n  ')
  const workingDays = workingDaysExpr(df, dt)
  const recoveryRateExpr = amountAlreadyNormalized
    ? 'CAST(NULL AS FLOAT64)'
    : 'SAFE_DIVIDE(total_amount, amount_assigned)'
  const amountRateRankExpr = amountAlreadyNormalized
    ? 'CAST(NULL AS INT64)'
    : 'RANK() OVER (ORDER BY recovery_rate DESC)'
  const amountDimensionScoreExpr = amountAlreadyNormalized
    ? `(${N} - amount_volume_rank) / ${N - 1}.0`
    : `((${N} - amount_rate_rank) / ${N - 1}.0 + (${N} - amount_volume_rank) / ${N - 1}.0) / 2`

  return `
final AS (
  ${unionAll}
),

-- Attach PTP results from the shared prologue; zero-fill agents with no PTPs
final_with_ptp AS (
  SELECT
    f.*,
    COALESCE(ps.total_ptps, 0)      AS total_ptp,
    COALESCE(ps.total_converted, 0) AS total_converted,
    COALESCE(ps.ptp_conv_rate, 0)   AS conversion_rate
  FROM final f
  LEFT JOIN ptp_summary ps ON ps.agent = LOWER(f.agent)
),

-- Fixed daily targets scaled to this report's working days, plus the new
-- rate metrics (contact→PTP, recovered÷assigned) alongside the existing
-- conversion_rate (PTP→payment), which was already a rate.
with_metrics AS (
  SELECT
    *,
    ROUND(${CALL_TARGET_PER_DAY}  * ${workingDays}) AS call_target,
    ROUND(${WA_TARGET_PER_DAY}    * ${workingDays}) AS wa_target,
    ROUND(${REACH_TARGET_PER_DAY} * ${workingDays}) AS reach_target,
    LEAST(1.0, SAFE_DIVIDE(total_calls,      ${CALL_TARGET_PER_DAY}  * ${workingDays})) AS call_attainment,
    LEAST(1.0, SAFE_DIVIDE(total_whatsapp,   ${WA_TARGET_PER_DAY}    * ${workingDays})) AS wa_attainment,
    LEAST(1.0, SAFE_DIVIDE(total_reach_days, ${REACH_TARGET_PER_DAY} * ${workingDays})) AS reach_attainment,
    SAFE_DIVIDE(total_ptp, customers_contacted) AS ptp_rate,
    ${recoveryRateExpr} AS recovery_rate
  FROM final_with_ptp
),

with_contact AS (
  SELECT
    *,
    (COALESCE(call_attainment, 0) + COALESCE(wa_attainment, 0) + COALESCE(reach_attainment, 0)) / 3 AS contact_attainment
  FROM with_metrics
),

-- Individual rate-rank / volume-rank per dimension, computed once here so
-- they can both feed weighted_score below AND be exposed as their own
-- output columns (for transparency into what's driving each agent's score).
ranked AS (
  SELECT
    *,
    RANK() OVER (ORDER BY ptp_rate        DESC) AS ptp_rate_rank,
    RANK() OVER (ORDER BY total_ptp       DESC) AS ptp_volume_rank,
    RANK() OVER (ORDER BY conversion_rate DESC) AS conversion_rate_rank,
    RANK() OVER (ORDER BY total_converted DESC) AS conversion_volume_rank,
    ${amountRateRankExpr} AS amount_rate_rank,
    RANK() OVER (ORDER BY total_amount    DESC) AS amount_volume_rank
  FROM with_contact
),

-- Each dimension's own 0-1 blended score (same rate+volume blend used in
-- weighted_score below), so it can be ranked on its own as a single
-- per-metric rank — the "PTP Rank" / "Conversion Rank" / "Amount Rank" a
-- viewer would expect, reflecting the new fairer blend underneath instead of
-- a single raw metric.
scored AS (
  SELECT
    *,
    ((${N} - ptp_rate_rank)   / ${N - 1}.0 + (${N} - ptp_volume_rank)   / ${N - 1}.0) / 2 AS ptp_dimension_score,
    ((${N} - conversion_rate_rank) / ${N - 1}.0 + (${N} - conversion_volume_rank) / ${N - 1}.0) / 2 AS conversion_dimension_score,
    ${amountDimensionScoreExpr} AS amount_dimension_score
  FROM ranked
),

weighted AS (
  SELECT
    *,
    (
      ${WEIGHT_CONTACT} * contact_attainment +
      ${WEIGHT_PTP} * ptp_dimension_score +
      ${WEIGHT_CONVERSION} * conversion_dimension_score +
      ${WEIGHT_AMOUNT} * amount_dimension_score
    ) AS weighted_score
  FROM scored
),

dim_ranked AS (
  SELECT
    *,
    RANK() OVER (ORDER BY contact_attainment         DESC) AS contact_rank,
    RANK() OVER (ORDER BY ptp_dimension_score        DESC) AS ptp_rank,
    RANK() OVER (ORDER BY conversion_dimension_score DESC) AS conversion_rank,
    RANK() OVER (ORDER BY amount_dimension_score      DESC) AS amount_rank
  FROM weighted
)

SELECT
  agent,
  total_calls,
  total_whatsapp,
  call_target,
  wa_target,
  total_reach_days,
  reach_target,
  reach_attainment,
  total_ptp,
  total_converted,
  total_amount,
  customers_contacted,
  amount_assigned,
  contact_attainment,
  ptp_rate,
  conversion_rate,
  recovery_rate,
  ptp_rate_rank,
  ptp_volume_rank,
  conversion_rate_rank,
  conversion_volume_rank,
  amount_rate_rank,
  amount_volume_rank,
  contact_rank,
  ptp_rank,
  conversion_rank,
  amount_rank,

  weighted_score,
  RANK() OVER (ORDER BY weighted_score DESC) AS overall_rank

FROM dim_ranked
ORDER BY overall_rank`
}

// ── Recoveries query ──────────────────────────────────────────────────────────
export function buildRecoveriesQuery({ dateFrom: df, dateTo: dt, includedInstitutions }: AgentPerfFilters): string {
  const instFilter      = buildInstFilter(includedInstitutions)
  const attributionCtes = buildRecoveryAttributionCtes(df, dt, instFilter)
  const agentCtes       = AGENTS.map(a => recoveryAgentCtePair(a.lower, df, dt, instFilter)).join(',')

  return `WITH ${sharedCtePrologue(df, dt, instFilter)},
${attributionCtes},
${agentCtes},
${finalSelect(df, dt)}`.trim()
}

// ── Normalized recovery query ─────────────────────────────────────────────────
// Same attribution as recoveries, but total_amount = SUM(deposit / lead_value)
// per attributed paying customer — a dimensionless recovery efficiency score.
export function buildNormalizedRecoveryQuery({ dateFrom: df, dateTo: dt, includedInstitutions }: AgentPerfFilters): string {
  const instFilter      = buildInstFilter(includedInstitutions)
  const attributionCtes = buildRecoveryAttributionCtes(df, dt, instFilter, true)
  const agentCtes       = AGENTS.map(a => recoveryAgentCtePair(a.lower, df, dt, instFilter)).join(',')

  return `WITH ${sharedCtePrologue(df, dt, instFilter)},
${attributionCtes},
${agentCtes},
${finalSelect(df, dt, true)}`.trim()
}

// ── Revenue query ─────────────────────────────────────────────────────────────
export function buildRevenueQuery({ dateFrom: df, dateTo: dt, includedInstitutions }: AgentPerfFilters): string {
  const instFilter      = buildInstFilter(includedInstitutions)
  const attributionCtes = buildRevenueAttributionCtes(df, dt, instFilter)
  const agentCtes       = AGENTS.map(a => revenueAgentCtePair(a.lower)).join(',')

  return `WITH ${sharedCtePrologue(df, dt, instFilter)},

revenue_base AS (
  SELECT
    d.date, d.client_id, d.phone, d.institution, d.daily_deposit_all_op,
    d.total_assigned_amount_due,
    d.kesta_call,      d.kesta_call_inbound,      d.kesta_call_logged,      d.kesta_whatsapp,
    d.dami_call,       d.dami_call_inbound,       d.dami_call_logged,       d.dami_whatsapp,
    d.gbolade_call,    d.gbolade_call_inbound,    d.gbolade_call_logged,    d.gbolade_whatsapp,
    d.diana_call,      d.diana_call_inbound,      d.diana_call_logged,      d.diana_whatsapp,
    d.jedidah_call,    d.jedidah_call_inbound,    d.jedidah_call_logged,    d.jedidah_whatsapp,
    d.emmanuella_call, d.emmanuella_call_inbound, d.emmanuella_call_logged, d.emmanuella_whatsapp,
    d.itoro_call,      d.itoro_call_inbound,      d.itoro_call_logged,      d.itoro_whatsapp,
    d.daily_deposit_all_op
      * CASE WHEN d.institution IN ('NUMIDA', 'NUMIDA ARCHIVED', 'PEZESHA') THEN fx.ngn_per_unit ELSE 1 END
      * CASE
          WHEN d.institution IN ('NUMIDA', 'NUMIDA ARCHIVED') AND d.min_days_in_arrears > 90               THEN 0.3
          WHEN d.institution IN ('NUMIDA', 'NUMIDA ARCHIVED') AND d.min_days_in_arrears BETWEEN 61 AND 90  THEN 0.15
          WHEN d.institution IN ('REMEDIAL HEALTH', 'REMEDIAL ARCHIVED',
                                 'KESSINGTON', 'KESSINGTON ARCHIVED')                                       THEN 0.175
          WHEN d.institution = 'VICTORY EMPOWERMENT' AND d.min_days_in_arrears > 90                        THEN 0.3
          WHEN d.institution = 'VICTORY EMPOWERMENT' AND d.min_days_in_arrears BETWEEN 61 AND 90           THEN 0.25
          WHEN d.institution = 'VICTORY EMPOWERMENT' AND d.min_days_in_arrears BETWEEN 31 AND 60           THEN 0.20
          WHEN d.institution = 'KUDA'                                                                       THEN 0.3
          WHEN d.institution = 'SYCAMORE MFB'                                                              THEN 0.325
          WHEN d.institution = 'SHARA'                                                                      THEN 0.25
          WHEN d.institution = 'GROOMING MFI' AND d.date >= '2026-04-01'                                   THEN 0.195
          WHEN d.institution = 'GROOMING MFI'                                                              THEN 0.25
          WHEN d.institution = 'GROOMING MFB' AND d.min_days_in_arrears > 90                               THEN 0.215
          WHEN d.institution = 'GROOMING MFB' AND d.min_days_in_arrears BETWEEN 61 AND 90                  THEN 0.175
          WHEN d.institution = 'GROOMING MFB' AND d.min_days_in_arrears BETWEEN 31 AND 60                  THEN 0.10
          WHEN d.institution = 'ROSABON'                                                                    THEN 0.135
          WHEN d.institution = 'LAPO'                                                                       THEN 0.10
          WHEN d.institution = 'LUKEFIELD'                                                                  THEN 0.2
          WHEN d.institution = 'NOLT' AND d.min_days_in_arrears > 180                                      THEN 0.30
          WHEN d.institution = 'NOLT' AND d.min_days_in_arrears BETWEEN 91 AND 180                         THEN 0.20
          WHEN d.institution = 'NOLT' AND d.min_days_in_arrears BETWEEN 61 AND 90                          THEN 0.175
          WHEN d.institution = 'NOLT' AND d.min_days_in_arrears BETWEEN 31 AND 60                          THEN 0.15
          WHEN d.institution = 'PEZESHA' AND d.min_days_in_arrears > 360                                   THEN 0.25
          WHEN d.institution = 'PEZESHA' AND d.min_days_in_arrears BETWEEN 181 AND 360                     THEN 0.2
          WHEN d.institution = 'PEZESHA' AND d.min_days_in_arrears BETWEEN 91 AND 180                      THEN 0.15
          WHEN d.institution = 'CREDIT DIRECT' AND d.min_days_in_arrears > 90                              THEN 0.15
          WHEN d.institution = 'CREDIT DIRECT' AND d.min_days_in_arrears BETWEEN 31 AND 90                 THEN 0.10
          WHEN d.institution = 'RENMONEY' AND d.date > '2026-06-11'                                        THEN 0.125
          WHEN d.institution = 'RENMONEY'                                                                   THEN 0.15
          WHEN d.institution = 'MAINSTREET'                                                                 THEN 0.25
          WHEN d.institution = 'AB MFB'                                                                     THEN 0.25
          WHEN d.institution = 'BAOBAB'                                                                     THEN 0.25
          ELSE 0
        END AS daily_revenue
  FROM \`fssspark.recovery_methods_data.recovery_dashboard_daily_table\` d
  CROSS JOIN conversion_rate fx
  WHERE d.date BETWEEN '${df}' AND '${dt}'
    ${instFilter}
),
${attributionCtes},
${agentCtes},
${finalSelect(df, dt)}`.trim()
}
