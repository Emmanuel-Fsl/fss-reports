from __future__ import annotations
import os
import json
import logging
import pandas as pd
import pandas_gbq
from google.oauth2 import service_account
import matplotlib as mpl
from matplotlib import cm, colors, font_manager, rcParams
from matplotlib.colors import Normalize
import re
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.offsetbox import OffsetImage, AnnotationBbox
import matplotlib.image as mpimg
from matplotlib.table import Table



montserrat_regular_path = "Montserrat-Regular.ttf"  # or "fonts/Montserrat-Regular.ttf" if inside /fonts
montserrat_bold_path = "Montserrat-Bold.ttf"
montserrat_italic_path = "Montserrat-Italic.ttf"

font_manager.fontManager.addfont(montserrat_regular_path)
font_manager.fontManager.addfont(montserrat_bold_path)
font_manager.fontManager.addfont(montserrat_italic_path)

# Define FontProperties for reuse
montserrat_regular = font_manager.FontProperties(fname=montserrat_regular_path)
montserrat_bold = font_manager.FontProperties(fname=montserrat_bold_path)
montserrat_italic= font_manager.FontProperties(fname=montserrat_italic_path)
# path to where you saved the font

COMPANY_LOGO_PATH  = "Old Logo.jpg"
COMPANY_LOGO_CREAM = "Logo cream.png"
COMPANY_NAME = "Fintech Solutions Services"
rcParams['font.family'] = 'Montserrat'
rcParams['font.size'] = 8.5             # smaller base font
rcParams['axes.titlesize'] = 11         # chart titles
rcParams['axes.labelsize'] = 8.5        # x/y labels
rcParams['figure.titlesize'] = 12       # figure-level title
rcParams['axes.titleweight'] = 'medium'
rcParams['legend.fontsize'] = 7
rcParams['xtick.labelsize'] = 7
rcParams['ytick.labelsize'] = 7


mpl.rcParams['axes.grid'] = False
mpl.rcParams['axes.grid.which'] = 'both'


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger(__name__)

# BigQuery settings
BQ_PROJECT_ID = os.getenv("BQ_PROJECT_ID", "fssspark")
# Service account JSON is supplied via env var (Cloud Run: set as a secret),
# not committed to source. Falls back to None, which makes the BigQuery
# client use Application Default Credentials instead.
SERVICE_JSON = os.getenv("BQ_SERVICE_ACCOUNT_JSON")
BQ_CREDS = (
    service_account.Credentials.from_service_account_info(json.loads(SERVICE_JSON))
    if SERVICE_JSON else None
)

# ── Configuration — edit these before running (or set env vars) ──────────────
DATE_FROM    = os.getenv("REPORT_DATE_FROM",    "2026-05-02")
DATE_TO      = os.getenv("REPORT_DATE_TO",      "2026-05-23")
DEPOSIT_TO   = os.getenv("REPORT_DEPOSIT_TO")   or None
_raw_insts   = os.getenv("REPORT_INSTITUTIONS", "GROOMING MFI,KUDA,SHARA")
INSTITUTIONS = [i.strip() for i in _raw_insts.split(",") if i.strip()]

# Prior period: same length window immediately before DATE_FROM
from datetime import date as _date, timedelta as _td
_d_from       = _date.fromisoformat(DATE_FROM)
_d_to         = _date.fromisoformat(DATE_TO)
_period_days  = (_d_to - _d_from).days + 1
PRIOR_DATE_TO   = (_d_from - _td(days=1)).isoformat()
PRIOR_DATE_FROM = (_d_from - _td(days=_period_days)).isoformat()

# ───────────────────────── SQL Query ──────────────────────────
def build_query(date_from: str, date_to: str, institutions=None, deposit_to: str = None) -> str:
    deposit_dt = deposit_to if (deposit_to and deposit_to > date_to) else date_to
    extended   = deposit_dt != date_to

    def _act(col: str) -> str:
        if extended:
            return f"CASE WHEN cur.date <= DATE '{date_to}' THEN ({col}) ELSE 0 END"
        return col

    sms_expr          = _act("cur.daily_sms_success + COALESCE(cur.daily_sms_pending_count, 0)")
    vb_expr           = _act("cur.daily_vb_outbound")
    agent_out_expr    = _act("cur.daily_agent_outbound + cur.combined_agent_whatsapp")
    va_bot_expr       = _act("COALESCE(cur.va_bot, 0)")
    va_bot_dur_expr   = _act("COALESCE(cur.va_bot_call_duration_sec, 0)")
    wa_bot_expr       = _act("COALESCE(cur.bot_whatsapp, 0)")
    email_expr        = _act("COALESCE(cur.daily_email_all_success, 0)")
    vb_cost_expr      = _act("cur.daily_vb_out_cost")
    sms_cost_expr     = _act("cur.daily_sms_cost")
    out_cost_expr     = _act("cur.daily_outbound_cost")
    agent_contact_expr = _act(
        "COALESCE(cur.daily_agent_outbound, 0) + COALESCE(cur.combined_agent_whatsapp, 0) + "
        "COALESCE(cur.daily_agent_inbound, 0) + "
        "CASE WHEN COALESCE(cur.daily_agent_outbound, 0) >= 1 "
        "OR COALESCE(cur.daily_agent_inbound, 0) >= 1 THEN 0 "
        "WHEN COALESCE(cur.daily_agent_outbound, 0) = 0 "
        "AND COALESCE(cur.daily_agent_inbound, 0) = 0 "
        "AND COALESCE(cur.combined_agent_call_logged, 0) >= 1 "
        "THEN COALESCE(cur.combined_agent_call_logged, 0) ELSE 0 END"
    )
    # Agent WA — WhatsApp-only agent contact (for Combo v2)
    agent_wa_expr = _act("COALESCE(cur.combined_agent_whatsapp, 0)")
    # Agent Call — voice-only agent contact, no WhatsApp (for Combo v3)
    agent_call_expr = _act(
        "COALESCE(cur.daily_agent_outbound, 0) + COALESCE(cur.daily_agent_inbound, 0) + "
        "CASE WHEN COALESCE(cur.daily_agent_outbound, 0) >= 1 "
        "OR COALESCE(cur.daily_agent_inbound, 0) >= 1 THEN 0 "
        "WHEN COALESCE(cur.daily_agent_outbound, 0) = 0 "
        "AND COALESCE(cur.daily_agent_inbound, 0) = 0 "
        "AND COALESCE(cur.combined_agent_call_logged, 0) >= 1 "
        "THEN COALESCE(cur.combined_agent_call_logged, 0) ELSE 0 END"
    )
    ew_max = f"LEAST(MAX(cur.date), DATE '{date_to}')" if extended else "MAX(cur.date)"

    if institutions:
        inst_list  = ", ".join(f"'{i}'" for i in institutions)
        inst_filter = f"AND cur.institution IN ({inst_list})"
    else:
        inst_filter = ""

    return f"""
            -- BigQuery Standard SQL
WITH params AS (
  SELECT
    DATE '{date_from}' AS start_date,
    DATE '{date_to}' AS end_date,
    DATE '{deposit_dt}' AS deposit_end_date,
    DATE_DIFF(
      DATE '{date_to}',
      DATE '{date_from}',
      WEEK(SATURDAY)
    ) + 1 AS weeks_spooled
),

base AS (
SELECT
  cur.client_id,
  MIN(cur.date) as current_week_start,
  MAX(cur.date) as current_week_end,
  LEAST(
    MAX(p.weeks_spooled),
    DATE_DIFF(
      DATE_TRUNC({ew_max}, WEEK(SATURDAY)),
      DATE_TRUNC(MIN(cur.min_portfolio_upload_date), WEEK(SATURDAY)),
      WEEK(SATURDAY)
    ) + 1
  ) AS effective_weeks,

  ANY_VALUE(cur.tier) AS tier,
  SUM({sms_expr}) as total_weekly_sms_success,
  SUM({vb_expr}) as total_weekly_vb_outbound,
  MAX(
    cur.cum_vb_outbound + cur.cum_sms_success + COALESCE(cur.cum_sms_pending_count, 0)
    + COALESCE(cur.cum_agent_outbound, 0) + COALESCE(cur.cum_agent_inbound, 0)
    + cur.cum_combined_agent_whatsapp + COALESCE(cur.cum_combined_bot, 0)
    + COALESCE(cur.cum_combined_agent_call_logged, 0)
    + COALESCE(cur.cum_email_all_success, 0)
  ) AS cum_rec,
  SUM({agent_out_expr}) as weekly_agent_outbound,
  SUM({va_bot_expr}) AS total_va_bot,
  MAX(COALESCE(cur.cum_va_bot, 0))                   AS cum_va_bot,
  MAX(COALESCE(cur.cum_bot_whatsapp, 0))             AS cum_wa_bot,
  MAX(COALESCE(cur.cum_email_all_success, 0))        AS cum_email,
  MAX(COALESCE(cur.cum_combined_agent_whatsapp, 0))  AS cum_agent_wa,
  SUM({va_bot_dur_expr}) AS va_bot_call_duration_sec,
  SUM({wa_bot_expr}) AS total_wa_bot,
  SUM({email_expr}) AS total_email,
  SUM(
    {agent_contact_expr}
  ) AS total_weekly_agent_contact,
  SUM({agent_wa_expr})   AS total_agent_wa,
  SUM({agent_call_expr}) AS total_agent_call,
  SUM(
    CASE
      WHEN cur.institution = 'ROSABON' THEN cur.daily_deposit_all * 0.135
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears > 90  THEN cur.daily_deposit_all * 0.30
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears BETWEEN 61 AND 90  THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears BETWEEN 31 AND 60  THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears > 180 THEN cur.daily_deposit_all * 0.30
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 91 AND 180  THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 61 AND 90   THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 31 AND 60   THEN cur.daily_deposit_all * 0.15
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears > 90  THEN cur.daily_deposit_all * 0.285
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'RENMONEY' AND DATE_DIFF(cur.date, cur.max_portfolio_upload_date, DAY) <= 40 THEN cur.daily_deposit_all * 0.15
      WHEN cur.institution = 'RENMONEY' THEN cur.daily_deposit_all * 0.125
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears > 90  THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.daily_deposit_all * 0.15
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.daily_deposit_all * 0.10
      WHEN cur.institution = 'NUMIDA' AND cur.min_days_in_arrears > 90  THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'NUMIDA' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.daily_deposit_all * 0.15
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears > 90  THEN cur.daily_deposit_all * 0.215
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.daily_deposit_all * 0.10
      WHEN cur.institution = 'SHARA'          THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'SYCAMORE MFB'   THEN cur.daily_deposit_all * 0.325
      WHEN cur.institution = 'LUKEFIELD'      THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'REMEDIAL HEALTH' THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'KESSINGTON'     THEN cur.daily_deposit_all * 0.175
      WHEN cur.institution = 'GROOMING MFI' AND cur.date > DATE '2026-04-01' THEN cur.daily_deposit_all * 0.195
      WHEN cur.institution = 'GROOMING MFI'   THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'LAPO'           THEN cur.daily_deposit_all * 0.10
      WHEN cur.institution = 'CREDIT DIRECT' AND cur.min_days_in_arrears > 90 THEN cur.daily_deposit_all * 0.15
      WHEN cur.institution = 'CREDIT DIRECT'  THEN cur.daily_deposit_all * 0.10
      WHEN cur.institution = 'KUDA'           THEN cur.daily_deposit_all * 0.30
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears > 360        THEN cur.daily_deposit_all * 0.25
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears BETWEEN 181 AND 360 THEN cur.daily_deposit_all * 0.20
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears BETWEEN 91  AND 180 THEN cur.daily_deposit_all * 0.15
      ELSE cur.daily_deposit_all * 0.25
    END
  ) AS weekly_deposit_all,

  MAX(
    CASE
      WHEN cur.institution = 'ROSABON' THEN cur.total_value_of_lead * 0.135
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears > 90  THEN cur.total_value_of_lead * 0.30
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears BETWEEN 61 AND 90  THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'VICTORY EMPOWERMENT' AND cur.min_days_in_arrears BETWEEN 31 AND 60  THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears > 180 THEN cur.total_value_of_lead * 0.30
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 91 AND 180  THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 61 AND 90   THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'NOLT' AND cur.min_days_in_arrears BETWEEN 31 AND 60   THEN cur.total_value_of_lead * 0.15
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears > 90  THEN cur.total_value_of_lead * 0.285
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'AB MFB' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'RENMONEY' AND DATE_DIFF(cur.date, cur.max_portfolio_upload_date, DAY) <= 40 THEN cur.total_value_of_lead * 0.15
      WHEN cur.institution = 'RENMONEY' THEN cur.total_value_of_lead * 0.125
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears > 90  THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.total_value_of_lead * 0.15
      WHEN cur.institution = 'MAINSTREET' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.total_value_of_lead * 0.10
      WHEN cur.institution = 'NUMIDA' AND cur.min_days_in_arrears > 90  THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'NUMIDA' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.total_value_of_lead * 0.15
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears > 90  THEN cur.total_value_of_lead * 0.215
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears BETWEEN 61 AND 90 THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'GROOMING MFB' AND cur.min_days_in_arrears BETWEEN 31 AND 60 THEN cur.total_value_of_lead * 0.10
      WHEN cur.institution = 'SHARA'          THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'SYCAMORE MFB'   THEN cur.total_value_of_lead * 0.325
      WHEN cur.institution = 'LUKEFIELD'      THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'REMEDIAL HEALTH' THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'KESSINGTON'     THEN cur.total_value_of_lead * 0.175
      WHEN cur.institution = 'GROOMING MFI' AND cur.date > DATE '2026-04-01' THEN cur.total_value_of_lead * 0.195
      WHEN cur.institution = 'GROOMING MFI'   THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'LAPO'           THEN cur.total_value_of_lead * 0.10
      WHEN cur.institution = 'CREDIT DIRECT' AND cur.min_days_in_arrears > 90 THEN cur.total_value_of_lead * 0.15
      WHEN cur.institution = 'CREDIT DIRECT'  THEN cur.total_value_of_lead * 0.10
      WHEN cur.institution = 'KUDA'           THEN cur.total_value_of_lead * 0.30
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears > 360        THEN cur.total_value_of_lead * 0.25
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears BETWEEN 181 AND 360 THEN cur.total_value_of_lead * 0.20
      WHEN cur.institution = 'PEZESHA' AND cur.min_days_in_arrears BETWEEN 91  AND 180 THEN cur.total_value_of_lead * 0.15
      ELSE cur.total_value_of_lead * 0.25
    END
  ) AS total_value_of_lead,
  ANY_VALUE(cur.loan_type) AS loan_type,
  MAX(cur.total_assigned_amount_due) AS total_assigned_amount_due,
  CASE
    WHEN ANY_VALUE(cur.loan_type) IN (
        'SMALL LOAN',
        'INDIVIDUAL LOAN FIELD',
        'ASSOCIATION LOAN FIELD',
        'PAKO LOAN MONTHLY',
        'MICRO LOAN',
        'STATE PUBLIC SECTOR LOAN',
        'FEDERAL PUBLIC SECTOR LOAN',
        'TOP-UP LOAN',
        'TOP-UP  LOAN',
        'INTEREST FREE LOAN',
        'GROOMING DAILY LOAN',
        'FESTIVAL LOAN'
    ) THEN 'Retail Unsecured'

    WHEN ANY_VALUE(cur.loan_type) = 'Business Loan'
         AND UPPER(ANY_VALUE(cur.institution)) IN ('REMEDIAL HEALTH', 'REMEDIAL-KESSINGTON')
    THEN 'SME Secured'

    WHEN ANY_VALUE(cur.loan_type) = 'Business Loan'
         AND UPPER(ANY_VALUE(cur.institution)) = 'SHARA'
    THEN 'SME Unsecured'

    WHEN ANY_VALUE(cur.loan_type) IN (
        'SME INDIVIDUAL LOAN',
        'SME LOAN (INDIVIDUAL)',
        'SME LOAN (GROUP)',
        'SME LOAN',
        'Business Loans - above 5m',
        'Business Loans -1m to 4.99m',
        'Business Loans - 500 to 999k',
        'LPO Financing'
    ) THEN 'SME Unsecured'

    WHEN ANY_VALUE(cur.loan_type) IN (
        'ASSET LOAN GROUP',
        'SOLAR LOAN',
        'GREEN ENERGY LOAN',
        'ASSET LOAN',
        'ASSET LOAN (INDIVIDUAL)',
        'MICRO ASSET LOAN',
        'Personal Loan - bankers'
    ) THEN 'Retail Secured'

    WHEN ANY_VALUE(cur.loan_type)  IN (
        'GREEN ENERGY CORPORATE LOAN'
    ) THEN 'SME Secured'

    ELSE 'Retail Unsecured'
    END AS loan_category,
   CASE
      WHEN MAX(cur.total_assigned_amount_due) < 50000 THEN 'Below 50k'
      WHEN MAX(cur.total_assigned_amount_due) < 100000 THEN '50k - 99k'
      WHEN MAX(cur.total_assigned_amount_due) < 250000 THEN '100k - 249k'
      WHEN MAX(cur.total_assigned_amount_due) < 500000 THEN '250k - 499k'
      WHEN MAX(cur.total_assigned_amount_due) < 1000000 THEN '500k - 999k'
      ELSE '1m+'
  END AS amount_category,
  CASE
    WHEN MAX(cur.max_days_in_arrears_running) <= 365 THEN '0-1 Year'
    WHEN MAX(cur.max_days_in_arrears_running) > 365 AND MAX(cur.max_days_in_arrears_running) <= 730 THEN '1-2 Years'
    WHEN MAX(cur.max_days_in_arrears_running) > 730 AND MAX(cur.max_days_in_arrears_running) <= 1095 THEN '2-3 Years'
    ELSE '3+ Years'
    END AS dpd,
  SUM({vb_cost_expr}) AS weekly_vb_out_cost,
  SUM({sms_cost_expr}) AS weekly_sms_cost,
  COALESCE(SUM({out_cost_expr}),0) AS weekly_outbound_cost,
  MAX(cur.Max_days_in_arrears) AS Max_days_in_arrears,
  ANY_VALUE(cur.loan_count) AS loan_count,
  ARRAY_AGG(cur.net_balance ORDER BY cur.date DESC LIMIT 1)[OFFSET(0)] AS final_balance,
  MAX(cur.max_portfolio_upload_date) AS max_portfolio_upload_date,
  ANY_VALUE(cur.institution) AS institution,
  PERCENTILE_CONT(MAX(cur.total_assigned_amount_due), 0.5)
            OVER (PARTITION BY ANY_VALUE(cur.institution)) AS median_amount,
        PERCENTILE_CONT(MAX(cur.max_days_in_arrears), 0.5)
            OVER (PARTITION BY ANY_VALUE(cur.institution)) AS median_days
FROM `fssspark.recovery_methods_data.recovery_dashboard_daily_table` AS cur
CROSS JOIN params p
WHERE cur.date BETWEEN p.start_date AND p.deposit_end_date
  {inst_filter}
GROUP BY 1
)

SELECT *,
ROUND(SAFE_DIVIDE(total_weekly_sms_success, effective_weeks)) AS weekly_sms_success,
ROUND(SAFE_DIVIDE(total_weekly_vb_outbound, effective_weeks)) AS weekly_vb_outbound,
ROUND(SAFE_DIVIDE(total_va_bot, effective_weeks)) AS weekly_va_bot,
SAFE_DIVIDE(va_bot_call_duration_sec, effective_weeks) AS weekly_va_bot_dur_sec,
ROUND(SAFE_DIVIDE(total_wa_bot, effective_weeks)) AS bot_whatsapp,
ROUND(SAFE_DIVIDE(total_email, effective_weeks)) AS weekly_email_all_success,
ROUND(SAFE_DIVIDE(total_weekly_agent_contact, effective_weeks)) AS weekly_agent_contact,
ROUND(SAFE_DIVIDE(total_agent_wa,            effective_weeks)) AS weekly_agent_wa,
ROUND(SAFE_DIVIDE(total_agent_call,          effective_weeks)) AS weekly_agent_call,
CASE
        WHEN total_assigned_amount_due > 75000
         AND max_days_in_arrears > 570
            THEN 'High Amount, High Days'

        WHEN total_assigned_amount_due > 75000
         AND max_days_in_arrears <= 570
            THEN 'High Amount, Low Days'

        WHEN total_assigned_amount_due <= 75000
         AND max_days_in_arrears > 570
            THEN 'Low Amount, High Days'

        ELSE 'Low Amount, Low Days'
    END AS client_bucket
    FROM base
    """


def retrieve_leads() -> pd.DataFrame:
    """Run the BigQuery and return a pandas DataFrame."""
    try:
        query = build_query(DATE_FROM, DATE_TO, INSTITUTIONS or None, DEPOSIT_TO)
        df = pandas_gbq.read_gbq(
            query,
            project_id=BQ_PROJECT_ID,
            credentials=BQ_CREDS,
            dialect="standard",
        )
        logger.info("Retrieved %d leads from BigQuery", len(df))
        return df
    except Exception as e:
        logger.error("BigQuery query failed: %s", e)
        return pd.DataFrame()


def retrieve_leads_prior() -> pd.DataFrame:
    """Run the same query over the prior equal-length period for comparison."""
    try:
        query = build_query(PRIOR_DATE_FROM, PRIOR_DATE_TO, INSTITUTIONS or None)
        df = pandas_gbq.read_gbq(
            query,
            project_id=BQ_PROJECT_ID,
            credentials=BQ_CREDS,
            dialect="standard",
        )
        logger.info("Retrieved %d prior-period leads from BigQuery", len(df))
        return df
    except Exception as e:
        logger.error("Prior-period BigQuery query failed: %s", e)
        return pd.DataFrame()



df_week = retrieve_leads()
if INSTITUTIONS:
    df_week = df_week[df_week["institution"].isin(INSTITUTIONS)].copy()

# Remove loan categories where total count = 0
cat_totals = df_week.groupby("loan_category")["loan_count"].sum()
valid_categories = cat_totals[cat_totals > 0].index.tolist()
df_week = df_week[df_week["loan_category"].isin(valid_categories)].copy()

df_prior_week = retrieve_leads_prior()
if INSTITUTIONS and not df_prior_week.empty:
    df_prior_week = df_prior_week[df_prior_week["institution"].isin(INSTITUTIONS)].copy()
if not df_prior_week.empty:
    df_prior_week["loan_category"] = df_prior_week["loan_category"].fillna("Unknown")

if df_week.empty:
    logger.info("FAILED: No data. Check query")

df_week["loan_category"] = df_week["loan_category"].fillna("Unknown")


Recovery_min = pd.to_datetime(DATE_FROM).strftime("%B %d, %Y")
Recovery_max = pd.to_datetime(DATE_TO).strftime("%B %d, %Y")
Deposit_max  = pd.to_datetime(DEPOSIT_TO if DEPOSIT_TO and DEPOSIT_TO > DATE_TO else DATE_TO).strftime("%B %d, %Y")


FORCE_MODE = None     # "daily" | "weekly" | None (auto-detect)

# Fallback unit costs (used only if dataset cost columns are missing)
COST_SMS_FALLBACK = 6.0
COST_VB_FALLBACK  = 7.0

MIN_N      = 100

# Label / readability controls
ANNOTATE_TOP_N     = None   # e.g., 8 to annotate only the top-N bins by N_Records. None = label all.
FONTSIZE_LABEL     = 7
LINE_GAP_FRACTION  = 0.045  # vertical gap between stacked lines as a fraction of y-range
BASE_HEADROOM_FRAC = 0.30   # extra headroom for tallest label (fraction of y-range)
Y_PAD_ABOVE_BAR_FRAC = 0.015  # gap between bar top and first line (fraction of y-range)
PCT_DECIMALS       = 2

PDF_PATH_DAILY  = os.getenv("REPORT_OUTPUT_PATH", "PROFIT_from_DAILY_counts_tiers0to2_joined.pdf")
PDF_PATH_WEEKLY = os.getenv("REPORT_OUTPUT_PATH", "Clean_PROFIT_from_WEEKLY_counts_hh_joined.pdf")
# Takes df_week from your first script:
df = df_week.copy()

# ───────────────────────── Helpers ────────────────────────
def find_col_case_insensitive(df: pd.DataFrame, target: str) -> str | None:
    tl = target.lower()
    for c in df.columns:
        if c.lower() == tl:
            return c
    return None

def resolve_any(df: pd.DataFrame, candidates: list[str]) -> str | None:
    for cand in candidates:
        col = find_col_case_insensitive(df, cand)
        if col is not None:
            return col
    return None

def to_numeric_fill0(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce").fillna(0.0)

def map_tier_join012(val) -> str | float:
    if pd.isna(val): return np.nan
    s = str(val).strip()
    m = re.search(r'\d+', s)
    if m:
        num = int(m.group(0))
        return "Tier 0-2" if num in (0, 1, 2) else f"Tier {num}"
    if s.isdigit():
        num = int(s)
        return "Tier 0-2" if num in (0, 1, 2) else f"Tier {num}"
    return s

def tier_sort_key(t: str) -> tuple:
    if str(t) == "Tier 0-2": return (0, "Tier 0-2")
    m = re.search(r'\d+', str(t))
    return (int(m.group(0)) if m else 9999, str(t))

def amount_sort_key(cat: str) -> tuple:
    order = {
        "Below 50k": 0,
        "50k - 99k": 1,
        "100k - 249k": 2,
        "250k - 499k": 3,
        "500k - 999k": 4,
        "1m+": 5,
    }
    return (order.get(cat, 999), cat)

def safe_int(n) -> int:
    try:
        if pd.isna(n): return 0
        return int(n)
    except Exception:
        return 0

def safe_num(x) -> float:
    if x is None: return 0.0
    if isinstance(x, float) and (np.isnan(x) or np.isinf(x)): return 0.0
    try:
        return float(x)
    except Exception:
        return 0.0

def fmt_roi(x):
    if pd.isna(x) or np.isinf(x): return "N/A"
    return f"{x:.1f}×"

def fmt_pct(x, dec=PCT_DECIMALS):
    if pd.isna(x) or np.isinf(x): return "N/A"
    try:
        return f"{100.0*float(x):.{dec}f}%"
    except Exception:
        return "N/A"

def fmt_money_short(x):
    x = safe_num(x)
    neg = x < 0
    val = abs(x)
    if val >= 1_000_000:
        s = f"{val/1_000_000:.1f}M"
    elif val >= 1_000:
        s = f"{val/1_000:.1f}K"
    else:
        s = f"{val:.0f}"
    return f"-₦{s}" if neg else f"₦{s}"

def add_intro_page(pp, min_date, max_date, max_deposit_date):
    fig, ax = plt.subplots(figsize=(8.5, 11), dpi=100)  # same as others
    ax.axis("off")

    # Background
    fig.patch.set_facecolor('#0A3D2D')

    # Colors
    title_color = 'white'
    footer_color = '#f5f2df'

    # === Logo placed via OffsetImage ===
    if COMPANY_LOGO_CREAM:
        try:
            from PIL import Image, ImageOps
            from matplotlib.offsetbox import OffsetImage, AnnotationBbox
            logo = Image.open(COMPANY_LOGO_CREAM).convert("RGBA")
            r, g, b, a = logo.split()
            white_img = Image.merge("RGBA", (
                ImageOps.invert(ImageOps.invert(r)),
                ImageOps.invert(ImageOps.invert(g)),
                ImageOps.invert(ImageOps.invert(b)),
                a
            ))
            logo_array = np.array(white_img)
            imagebox = OffsetImage(logo_array, zoom=0.158)
            ab = AnnotationBbox(imagebox, (0.5, 0.86),
                                frameon=False, xycoords='figure fraction')
            fig.add_artist(ab)
        except Exception as e:
            print(f"⚠️ Logo not found or could not be added: {e}")

    # Company name (below logo)
    ax.text(0.5, 0.74, "Fintech Solutions Services",
            ha='center', va='center',
            fontsize=12,
            fontproperties=montserrat_bold,
            color=title_color,
            transform=ax.transAxes,
            linespacing=1.3)

    # Title
    ax.text(0.5, 0.60, "Recovery Weekly\nReport",
            ha='center', va='center',
            fontsize=32,
            fontproperties=montserrat_bold,
            color=footer_color,
            transform=ax.transAxes,
            linespacing=1.25)

    # Date
    ax.text(0.5, 0.50, f"Recoveries from {min_date} to {max_date}",
            ha='center', va='center',
            fontsize=8,
            fontproperties=montserrat_regular,
            transform=ax.transAxes,
            color=title_color)
    ax.text(0.5, 0.46, f"Deposits from {min_date} to {max_deposit_date}",
            ha='center', va='center',
            fontsize=8,
            fontproperties=montserrat_regular,
            transform=ax.transAxes,
            color=title_color)

    # Separator
    ax.plot([0.35, 0.65], [0.44, 0.44], transform=fig.transFigure,color=title_color, linewidth=1.3)

    # Footer
    ax.text(0.05, 0.06, "For Key Stakeholders",
            ha='left', va='bottom',
            fontsize=9,
            fontproperties=montserrat_regular,
            color=footer_color,
            transform=ax.transAxes,
            linespacing=1.3)

    ax.text(0.95, 0.06, "Tobe Melville Ofili\n Olaoluwapo Oyefolu",
            ha='right', va='bottom',
            fontsize=9,
            fontproperties=montserrat_regular,
            color=footer_color,
            transform=ax.transAxes,
            linespacing=1.3)

    # Save without resizing the bounding box
    pp.savefig(fig, facecolor=fig.get_facecolor(), bbox_inches=None, pad_inches=0)
    plt.close(fig)

def add_institution_intro_page(pp, inst_name):
    # === Theme config ===
    configs = {
        "SHARA":          {"text_color": "#0B3D02", "logo": "Shara Logo.png",         "logo_zoom": 0.55},
        "GROOMING MFI":   {"text_color": "#8B0000", "logo": "Grooming Logo.png",       "logo_zoom": 0.13},
        "GROOMING MFB":   {"text_color": "#8B0000", "logo": "Grooming Logo.png",       "logo_zoom": 0.13},
        "KUDA":           {"text_color": "#4B0082", "logo": "Kuda Logo.png",           "logo_zoom": 0.80},
        "CREDIT DIRECT":  {"text_color": "#003087", "logo": "Credit Direct Logo.png",  "logo_zoom": 0.18},
        "REMEDIAL HEALTH":{"text_color": "#001F5B", "logo": "Remedial Logo.png",       "logo_zoom": 0.18},
        "KESSINGTON":     {"text_color": "#333333", "logo": None,                      "logo_zoom": 0.18},
    }

    theme = configs.get(inst_name.upper(), {"text_color": "#333333", "logo": None, "logo_zoom": 0.55})

    # === Figure setup ===
    fig, ax = plt.subplots(figsize=(8.5, 11), dpi=100)
    ax.axis("off")
    fig.patch.set_facecolor("white")
    add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME)

    # === Accent lines ===
    color = theme["text_color"]
    ax.plot([0.10, 0.90], [0.62, 0.62], color=color, linewidth=1.2,
            transform=ax.transAxes, alpha=0.35)
    ax.plot([0.10, 0.90], [0.36, 0.36], color=color, linewidth=1.2,
            transform=ax.transAxes, alpha=0.35)

    # === Institution logo (centered between lines) ===
    if theme["logo"]:
        try:
            logo_img = mpimg.imread(theme["logo"])
            imagebox = OffsetImage(logo_img, zoom=theme["logo_zoom"])
            ab = AnnotationBbox(
                imagebox, (0.5, 0.50),
                xycoords="axes fraction",
                frameon=False,
                zorder=3,
            )
            ax.add_artist(ab)
        except Exception as e:
            print(f"Could not load institution logo {theme['logo']}: {e}")

    # === Institution name ===
    ax.text(
        0.5, 0.30, inst_name.lower(),
        ha="center", va="center",
        fontsize=28,
        fontproperties=montserrat_bold,
        color=color,
        transform=ax.transAxes,
        zorder=2,
    )

    # === Save page ===
    pp.savefig(fig, facecolor=fig.get_facecolor(), bbox_inches=None, pad_inches=0)
    plt.close(fig)



# --- Global counter ---
PAGE_COUNTER = 0

def add_header(fig, company_logo_path, company_name,institution=None):
    """
    Adds a company logo (left) and green company name (right) to the top of the figure.
    """
    global PAGE_COUNTER
    PAGE_COUNTER += 1  # increase each time this runs


    # --- Add Logo ---
    try:
        logo = mpimg.imread(company_logo_path)
        imagebox = OffsetImage(logo, zoom=0.3)
        ab = AnnotationBbox(imagebox, (0.05, 0.97), frameon=False, xycoords='figure fraction')
        fig.add_artist(ab)
    except Exception as e:
        print(f"⚠️ Logo not found or could not be added: {e}")

    # --- Add Company Name (Right, Green) ---
    fig.text(
        0.09, 0.97, company_name,
        ha='left', va='top',
        fontproperties=montserrat_bold,  # keep your font style
        fontsize=10,
        color="#008000"  # GREEN
    )

     # --- Institution (Centered) ---
    if institution:
        fig.text(
            0.50, 0.965, institution.lower(),
            ha='center', va='top',
            fontproperties=montserrat_regular,
            fontsize=9,
            color="#666666"
        )

    

    # --- Add Separator Line ---
    fig.lines.append(
        plt.Line2D([0.03, 0.97], [0.94, 0.94], transform=fig.transFigure, color='#CCCCCC', linewidth=0.5)
    )

     # --- Page Number ---
    if PAGE_COUNTER == 1:
        page_label = "i"
    elif PAGE_COUNTER == 2:
        page_label = "ii"
    else:
        page_label = f"Page {PAGE_COUNTER - 2}"
    fig.text(
            0.97, 0.97, page_label,
            ha='right', va='top',
            fontproperties=montserrat_regular,
            fontsize=8,
            color="#333333"
        )

    # --- Optional Footer ---
    fig.text(
        0.5, 0.02, "Recovery weekly Report",
        ha='center', va='bottom',
        fontproperties=montserrat_regular,
        fontsize=6.5,
        color="#666666"
    )



# ───────────────────────── Column Resolver ────────────────
def resolve_mode_and_columns(df: pd.DataFrame, force_mode: str | None = None):
    """
    Returns:
      mode, sms_col, vb_col, dep_col, date_col, tvol_col, final_bal_col,
      sms_cost_col, vb_cost_col, pdf_path
    """
    # counts
    daily_sms  = ["daily_sms_success", "daily_sms_success_days", "sms_daily", "daily_sms"]
    daily_vb   = ["daily_vb_outbound", "daily_voice_outbound", "vb_daily", "daily_vb"]
    daily_dep  = ["daily_deposit_all", "daily_recovery_all", "deposit_daily_all", "daily_amount"]
    daily_date = ["date", "day", "day_date"]
    daily_outbound = ["daily_agent_outbound", "daily_outbound_agent"]
    # costs
    daily_sms_cost = ["daily_sms_cost", "sms_daily_cost", "daily_cost_sms", "sms_cost_daily"]
    daily_vb_cost  = ["daily_vb_out_cost", "daily_vb_cost", "daily_voice_broadcast_cost",
                      "daily_voice_out_cost", "vb_cost_daily", "vb_daily_cost"]
    daily_outbound_cost = ["daily_outbound_cost", "daily_out_cost"]                  

    weekly_sms  = ["weekly_sms_success", "weekly_sms_success_days", "sms_weekly", "weekly_sms"]
    weekly_vb   = ["weekly_vb_outbound", "weekly_voice_outbound", "vb_weekly", "weekly_vb"]
    weekly_dep  = ["weekly_deposit_all", "weekly_recovery_all", "deposit_weekly_all", "weekly_amount"]
    weekly_date = ["week", "week_start", "week_end", "date"]
    weekly_outbound = ["weekly_agent_outbound", "weekly_outbound_agent"]
    weekly_sms_cost = ["weekly_sms_cost", "sms_weekly_cost", "weekly_cost_sms"]
    weekly_vb_cost  = ["weekly_vb_out_cost", "weekly_vb_cost", "weekly_voice_broadcast_cost",
                       "weekly_voice_out_cost", "vb_weekly_cost", "voice_weekly_cost"]
    weekly_outbound_cost = ["weekly_outbound_cost", "weekly_out_cost"]   
    tvol_cands  = ["total_value_of_lead", "total_value"]
    fb_cands    = ["final_balance", "balance_final", "remaining_balance", "outstanding_balance"]
    daily_cum_rec = ["cum_rec"]
    weekly_cum_rec = ["cum_rec"]

    def _res(prefix: str):
        if prefix == "daily":
            sms = resolve_any(df, daily_sms)
            vb  = resolve_any(df, daily_vb)
            dep = resolve_any(df, daily_dep)
            dt  = resolve_any(df, daily_date)
            sms_cost = resolve_any(df, daily_sms_cost)
            vb_cost  = resolve_any(df, daily_vb_cost)
            cum_rec = resolve_any(df, daily_cum_rec)
            out = resolve_any(df,daily_outbound)
            out_cost = resolve_any(df, daily_outbound_cost)
            pdf = PDF_PATH_DAILY
        else:
            sms = resolve_any(df, weekly_sms)
            vb  = resolve_any(df, weekly_vb)
            dep = resolve_any(df, weekly_dep)
            dt  = resolve_any(df, weekly_date)
            sms_cost = resolve_any(df, weekly_sms_cost)
            vb_cost  = resolve_any(df, weekly_vb_cost)
            cum_rec = resolve_any(df, weekly_cum_rec)
            out = resolve_any(df,weekly_outbound)
            out_cost = resolve_any(df, weekly_outbound_cost)
            pdf = PDF_PATH_WEEKLY
        tvol = resolve_any(df, tvol_cands)
        fb   = resolve_any(df, fb_cands)
        return sms, vb, out,  dep, dt,cum_rec, tvol, fb, sms_cost, vb_cost,out_cost, pdf

    if force_mode in {"daily", "weekly"}:
        sms, vb,out, dep, dt, cum_rec,tvol, fb, sms_cost, vb_cost,out_cost, pdf = _res(force_mode)
        if any(c is None for c in [sms, vb, dep]):
            raise ValueError(f"Forced mode='{force_mode}' but required columns not found.")
        return force_mode, sms, vb, out, dep, dt,cum_rec, tvol, fb, sms_cost, vb_cost, out_cost, pdf

    sms_w, vb_w, out_w, dep_w, dt_w,cum_rec_w, tvol_w, fb_w, sms_cost_w, vb_cost_w, out_cost_w, pdf_w = _res("weekly")
    if all(c is not None for c in [sms_w, vb_w, dep_w]):
        return "weekly", sms_w, vb_w, out_w, dep_w, dt_w, cum_rec_w, tvol_w, fb_w, sms_cost_w, vb_cost_w, out_cost_w, pdf_w

    sms_d, vb_d, out_d, dep_d, dt_d, cum_rec_d, tvol_d, fb_d, sms_cost_d, vb_cost_d, out_cost_d, pdf_d = _res("daily")
    if all(c is not None for c in [sms_d, vb_d, dep_d]):
        return "daily", sms_d, vb_d, out_d, dep_d, dt_d, cum_rec_d, tvol_d, fb_d, sms_cost_d, vb_cost_d, out_cost_d, pdf_d

    missing = []
    if sms_w is None and sms_d is None: missing.append("sms (daily/weekly)")
    if vb_w  is None and vb_d  is None: missing.append("vb (daily/weekly)")
    if out_w  is None and out_d  is None: missing.append("outbound (daily/weekly)")
    if dep_w is None and dep_d is None: missing.append("deposit (daily/weekly)")
    raise ValueError("Missing required columns: " + ", ".join(missing))

# ───────────────────────── Aggregation Core ───────────────
def build_method_summary(df: pd.DataFrame,
                         count_col: str,
                         deposit_col: str,
                         cost_col: str | None,
                         unit_cost_fallback: float,
                         tier_col: str,
                         tvol_col: str | None,
                         final_bal_col: str | None,
                         cum_rec:str | None):
    """
    Returns:
      pieces, chart_totals, tiers
    Includes stacked-label fields:
      Profit_per_Record, Cost_per_Record, Revenue_per_Record, ROI_per_Record,
      N_Records, Paying_Customers, Profit_per_Payer, Avg_TVOL,
      RR_count (= payers/N), RR_value (= SUM(deposit)/SUM(final_balance))
    """
    pieces, chart_totals = [], {}
    client_totals = {}
    if tier_col == "amount_category":
        tiers = sorted([t for t in df[tier_col].dropna().unique().tolist()], key=amount_sort_key) or ["Below 50k"]
        print(tiers)
    else:
        tiers = sorted([t for t in df[tier_col].dropna().unique().tolist()], key=tier_sort_key) or ["All Tiers"]

    for tg in tiers:
        sub = df[df[tier_col] == tg].copy()
        chart_totals[tg] = int(sub.shape[0])
        # N_Records == N_Clients by construction (one row per client)
        client_totals[tg] = int(sub.shape[0])

        # Cost per record: prefer dataset column; fallback to count * unit cost
        if cost_col and cost_col in sub.columns:
            sub["__cost"] = pd.to_numeric(sub[cost_col], errors="coerce").fillna(0.0).clip(lower=0)
        else:
            sub["__cost"] = sub[count_col].clip(lower=0) * float(unit_cost_fallback)

        sub["__tvol"] = pd.to_numeric(sub[tvol_col], errors="coerce") if (tvol_col and tvol_col in sub.columns) else np.nan
        sub["__fb"]   = pd.to_numeric(sub[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in sub.columns) else np.nan

        g = (sub.groupby(count_col, dropna=False)
               .agg(Revenue_per_Record=(deposit_col, "mean"),
                    Cost_per_Record=("__cost", "mean"),
                    N_Records=(count_col, "size"),
                    Paying_Customers=("__payer", "sum"),
                    Revenue_Sum=(deposit_col, "sum"),
                    Cost_Sum=("__cost", "sum"),
                    Avg_TVOL=("__tvol", "mean"),
                    FinalBalance_Sum=("__fb", "sum"))
               .reset_index()
               .rename(columns={count_col: "Count"}))

        # N_Clients == N_Records since one row per client
        g["N_Clients"] = g["N_Records"]

        g["Profit_per_Record"] = g["Revenue_per_Record"] - g["Cost_per_Record"]
        g["ROI_per_Record"]    = np.where(g["Cost_per_Record"] > 0,
                                          g["Profit_per_Record"] / g["Cost_per_Record"],
                                          np.nan)
        g["Profit_Total"]      = g["Revenue_Sum"] - g["Cost_Sum"]
        g["Profit_per_Payer"]  = np.where(g["Paying_Customers"] > 0,
                                          g["Profit_Total"] / g["Paying_Customers"],
                                          np.nan)

        # Recovery rates
        g["RR_count"] = np.where(g["N_Records"] > 0,
                                 g["Paying_Customers"] / g["N_Records"], np.nan)
        g["RR_value"] = np.where(g["FinalBalance_Sum"] > 0,
                                 g["Revenue_Sum"] / g["FinalBalance_Sum"], np.nan)
        g["RA_value"] = np.where(g["Paying_Customers"] > 0, g["Revenue_Sum"]/ g["Paying_Customers"],np.nan)


        g = g.sort_values("Count").reset_index(drop=True)
        pieces.append((tg, g))
    return pieces, chart_totals, tiers, client_totals

# ───────────────────────── Main Flow ──────────────────────
mode, sms_col, vb_col,out_col, dep_col, date_col, cum_rec, tvol_col, final_bal_col, sms_cost_col, vb_cost_col, out_cost_col, PDF_PATH = resolve_mode_and_columns(df, FORCE_MODE)

# Coerce numerics and prep
df[sms_col] = to_numeric_fill0(df[sms_col])
df[vb_col]  = to_numeric_fill0(df[vb_col])
df[dep_col] = to_numeric_fill0(df[dep_col])
if tvol_col is not None:       df[tvol_col]       = to_numeric_fill0(df[tvol_col])
if final_bal_col is not None:  df[final_bal_col]  = to_numeric_fill0(df[final_bal_col])
if sms_cost_col:               df[sms_cost_col]   = to_numeric_fill0(df[sms_cost_col])
if vb_cost_col:                df[vb_cost_col]    = to_numeric_fill0(df[vb_cost_col])



df["tier_group"] = df["tier"].apply(map_tier_join012) if "tier" in df.columns else "All Tiers"
df["sms_count"]  = np.rint(df[sms_col]).astype(int)
df["vb_count"]   = np.rint(df[vb_col]).astype(int)
df["out_count"]  = np.rint(df[out_col]).astype(int)
df["__payer"]    = (df[dep_col] > 0).astype(int)

def _to_int_col(df, col):
    return np.rint(pd.to_numeric(df[col], errors="coerce").fillna(0)).astype(int) if col in df.columns else 0

df["va_bot_count"]        = _to_int_col(df, "total_va_bot")
df["cum_va_bot"]          = _to_int_col(df, "cum_va_bot")
df["cum_wa_bot"]          = _to_int_col(df, "cum_wa_bot")
df["cum_email"]           = _to_int_col(df, "cum_email")
df["cum_agent_wa"]        = _to_int_col(df, "cum_agent_wa")
df["wa_bot_count"]        = _to_int_col(df, "total_wa_bot")
df["email_count"]         = _to_int_col(df, "total_email")
df["agent_contact_count"] = _to_int_col(df, "total_weekly_agent_contact")
df["agent_wa_count"]      = _to_int_col(df, "total_agent_wa")
df["agent_call_count"]    = _to_int_col(df, "total_agent_call")
df["va_bot_cost"]         = pd.to_numeric(df["va_bot_call_duration_sec"], errors="coerce").fillna(0).clip(lower=0) * 2.5 if "va_bot_call_duration_sec" in df.columns else 0.0
df["email_cost"]          = pd.to_numeric(df["total_email"], errors="coerce").fillna(0).clip(lower=0) * 1.0  if "total_email" in df.columns else 0.0
df["wa_bot_cost"]         = 0.0

# Combined SMS + VB cost
# Ensure numeric
df[sms_cost_col] = pd.to_numeric(df[sms_cost_col], errors="coerce").fillna(0.0).clip(lower=0)
df[vb_cost_col]  = pd.to_numeric(df[vb_cost_col],  errors="coerce").fillna(0.0).clip(lower=0)
df["total_cost"] = df[sms_cost_col] + df[vb_cost_col]

# Force 0 cost if no SMS and no VB
df.loc[(df["sms_count"] == 0) & (df["vb_count"] == 0), "total_cost"] = 0.0


# ── Prior-period processing ──────────────────────────────────────────────────
def _prep_prior_df(df_p: pd.DataFrame) -> pd.DataFrame:
    """Apply minimum column assignments needed to compute prior-period profit."""
    if df_p.empty:
        return df_p
    df_p = df_p.copy()
    # Resolve columns the same way as the current period
    _, sms_p, vb_p, out_p, dep_p, _, _, _, _, sms_cost_p, vb_cost_p, out_cost_p, _ = resolve_mode_and_columns(df_p, FORCE_MODE)

    df_p["tier_group"]       = df_p["tier"].apply(map_tier_join012) if "tier" in df_p.columns else "All Tiers"
    df_p["sms_count"]        = np.rint(pd.to_numeric(df_p[sms_p], errors="coerce").fillna(0)).astype(int)
    df_p["vb_count"]         = np.rint(pd.to_numeric(df_p[vb_p],  errors="coerce").fillna(0)).astype(int)
    df_p["out_count"]        = np.rint(pd.to_numeric(df_p[out_p], errors="coerce").fillna(0)).astype(int) if out_p and out_p in df_p.columns else 0
    df_p["va_bot_count"]     = _to_int_col(df_p, "total_va_bot")
    df_p["wa_bot_count"]     = _to_int_col(df_p, "total_wa_bot")
    df_p["email_count"]      = _to_int_col(df_p, "total_email")
    df_p["agent_wa_count"]   = _to_int_col(df_p, "total_agent_wa")
    df_p["agent_call_count"] = _to_int_col(df_p, "total_agent_call")
    df_p["agent_contact_count"] = _to_int_col(df_p, "total_weekly_agent_contact")
    df_p["cum_rec"]          = _to_int_col(df_p, "cum_rec") if "cum_rec" in df_p.columns else 0
    df_p["cum_va_bot"]       = _to_int_col(df_p, "cum_va_bot")
    df_p["cum_wa_bot"]       = _to_int_col(df_p, "cum_wa_bot")
    df_p["cum_email"]        = _to_int_col(df_p, "cum_email")
    df_p["cum_agent_wa"]     = _to_int_col(df_p, "cum_agent_wa")
    df_p["va_bot_cost"]      = pd.to_numeric(df_p.get("va_bot_call_duration_sec", 0), errors="coerce").fillna(0).clip(lower=0) * 2.5 if "va_bot_call_duration_sec" in df_p.columns else 0.0
    df_p["email_cost"]       = pd.to_numeric(df_p.get("total_email", 0), errors="coerce").fillna(0).clip(lower=0) * 1.0  if "total_email" in df_p.columns else 0.0
    df_p["wa_bot_cost"]      = 0.0

    _sms_c = pd.to_numeric(df_p[sms_cost_p], errors="coerce").fillna(0).clip(lower=0) if sms_cost_p and sms_cost_p in df_p.columns else 0.0
    _vb_c  = pd.to_numeric(df_p[vb_cost_p],  errors="coerce").fillna(0).clip(lower=0) if vb_cost_p  and vb_cost_p  in df_p.columns else 0.0
    _out_c = pd.to_numeric(df_p[out_cost_p], errors="coerce").fillna(0).clip(lower=0) if out_cost_p and out_cost_p in df_p.columns else 0.0

    df_p["__all_cost"] = _sms_c + _vb_c + _out_c + df_p["va_bot_cost"] + df_p["email_cost"]
    df_p["__dep"]      = pd.to_numeric(df_p[dep_p], errors="coerce").fillna(0)
    df_p["__profit"]   = df_p["__dep"] - df_p["__all_cost"]

    df_p["Combo"]    = df_p.apply(combo_label_row,    axis=1)
    df_p["Combo_v2"] = df_p.apply(combo_label_row_v2, axis=1)
    df_p["Combo_v3"] = df_p.apply(combo_label_row_v3, axis=1)
    logger.info("Prior df prepared: %d rows | dep_col=%s | profit sample: %s",
                len(df_p), dep_p,
                df_p["__profit"].describe().to_dict() if "__profit" in df_p.columns else "MISSING")
    logger.info("Prior Combo sample: %s", df_p["Combo"].value_counts().to_dict())
    if "tier_group" in df_p.columns:
        logger.info("Prior tier_groups: %s", df_p["tier_group"].unique().tolist())
    return df_p


def build_prior_combo_lookup(df_p: pd.DataFrame, combo_col: str, group_col: str) -> dict:
    """Return {(group_val, combo_label): (profit_per_record, n_records)} for prior period."""
    if df_p.empty or combo_col not in df_p.columns or group_col not in df_p.columns:
        logger.info("build_prior_combo_lookup: empty or missing cols (combo=%s, group=%s, cols=%s)",
                    combo_col, group_col, list(df_p.columns) if not df_p.empty else "EMPTY")
        return {}
    agg = (
        df_p.groupby([group_col, combo_col])
        .agg(profit=("__profit", "mean"), n=("__profit", "size"))
        .reset_index()
    )
    result = {
        (row[group_col], row[combo_col]): (float(row["profit"]), int(row["n"]))
        for _, row in agg.iterrows()
    }
    logger.info("build_prior_combo_lookup(%s, %s): %d entries, sample keys: %s",
                combo_col, group_col, len(result), list(result.keys())[:3])
    return result


def build_prior_count_lookup(df_p: pd.DataFrame, count_col: str, group_col: str) -> dict:
    """
    Return {(group_val, count_val): (profit_per_record, n_records)} for the prior period.
    Same idea as build_prior_combo_lookup, but keyed by a numeric Count bucket
    (e.g. sms_count / vb_count / va_bot_count) instead of a Combo label — this is
    what the non-Combo, Count-based bubble charts (SMS, VB, VA Bot) need to look up.
    """
    if df_p.empty or count_col not in df_p.columns or group_col not in df_p.columns:
        logger.info("build_prior_count_lookup: empty or missing cols (count=%s, group=%s, cols=%s)",
                    count_col, group_col, list(df_p.columns) if not df_p.empty else "EMPTY")
        return {}
    agg = (
        df_p.groupby([group_col, count_col])
        .agg(profit=("__profit", "mean"), n=("__profit", "size"))
        .reset_index()
    )
    result = {
        (row[group_col], row[count_col]): (float(row["profit"]), int(row["n"]))
        for _, row in agg.iterrows()
    }
    logger.info("build_prior_count_lookup(%s, %s): %d entries, sample keys: %s",
                count_col, group_col, len(result), list(result.keys())[:3])
    return result


# ─────────────────────────────────────────────────────────────────────────────

def filter_contact_segment(df: pd.DataFrame, segment: str) -> pd.DataFrame:
    sms = pd.to_numeric(df["sms_count"], errors="coerce").fillna(0)
    vb  = pd.to_numeric(df["vb_count"],  errors="coerce").fillna(0)
    out = pd.to_numeric(df["out_count"],  errors="coerce").fillna(0) if "out_count" in df.columns else 0
    if segment == "sms_only":
        mask = (sms > 0) & (vb <= 0) & (out <= 0)
    elif segment == "sms_vb_only":
        mask = (sms > 0) & (vb > 0) & (out <= 0)
    else:
        raise ValueError(f"Unknown segment: {segment}")
    return df.loc[mask].copy()

# Build SMS / VB summaries (now using cost columns where available)
df_sms_only    = filter_contact_segment(df, "sms_only")
df_sms_vb_only = filter_contact_segment(df, "sms_vb_only")
df_sms_vb_only["sms_vb_count"] = df_sms_vb_only[["sms_count", "vb_count"]].min(axis=1).astype(int)

sms_pieces, chart_totals_sms, tiers, sms_client_totals = build_method_summary(
    df_sms_only, "sms_count", dep_col, sms_cost_col, COST_SMS_FALLBACK, "tier_group", tvol_col, final_bal_col, cum_rec
)
sms_vb_pieces, _, _, sms_vb_client_totals = build_method_summary(
    df_sms_vb_only, "sms_vb_count", dep_col, "total_cost", COST_SMS_FALLBACK + COST_VB_FALLBACK, "tier_group", tvol_col, final_bal_col, cum_rec
)
vb_pieces, chart_totals_sms, tiers, vb_client_totals = build_method_summary(
    df, "vb_count", dep_col, vb_cost_col, COST_VB_FALLBACK, "tier_group", tvol_col, final_bal_col, cum_rec
)


# Combos
def combo_label_row(row):
    s = pd.to_numeric(row.get("total_weekly_sms_success", row.get("sms_count", 0)), errors="coerce") > 0
    v = pd.to_numeric(row.get("total_weekly_vb_outbound", row.get("vb_count", 0)), errors="coerce") > 0
    o = pd.to_numeric(row.get("agent_contact_count", row.get("out_count", 0)), errors="coerce") > 0
    c = pd.to_numeric(row["cum_rec"], errors="coerce") > 0

    if o: return "Agent Contact"
    if s and v and not o: return "SMS + VB"
    if v and not s and not o: return "VB only"
    if s and not v and not o: return "SMS only"
    if c and not s and not v and not o:  return "None(no cont.)"
    return "Never(no cont.)"

def combo_label_row_v2(row):
    wa = pd.to_numeric(row.get("wa_bot_count",   0), errors="coerce") > 0
    ag = pd.to_numeric(row.get("agent_wa_count", 0), errors="coerce") > 0
    em = pd.to_numeric(row.get("email_count",    0), errors="coerce") > 0

    if wa and ag:   return "WA + Agent WA"
    if wa and em:   return "WA + Email"
    if wa:          return "WA"
    if ag:          return "Agent WA"
    if em:          return "Email"

    cum_wa = pd.to_numeric(row.get("cum_wa_bot",   0), errors="coerce") > 0
    cum_ag = pd.to_numeric(row.get("cum_agent_wa", 0), errors="coerce") > 0
    cum_em = pd.to_numeric(row.get("cum_email",    0), errors="coerce") > 0
    if cum_wa or cum_ag or cum_em:  return "None"
    return "Never"

def combo_label_row_v3(row):
    va  = pd.to_numeric(row.get("va_bot_count",   0), errors="coerce") > 0
    ag  = pd.to_numeric(row.get("agent_call_count", 0), errors="coerce") > 0
    cum = pd.to_numeric(row.get("cum_va_bot",      0), errors="coerce") > 0

    if va and ag:        return "VA + Agent Call"
    if va:               return "VA"
    if ag:               return "Agent Call"
    if cum:              return "None"
    return "Never"

df["Combo"]    = df.apply(combo_label_row, axis=1)
df["Combo_v2"] = df.apply(combo_label_row_v2, axis=1)
df["Combo_v3"] = df.apply(combo_label_row_v3, axis=1)

# Prior-period df — must be called after combo label functions are defined
df_prior = _prep_prior_df(df_prior_week)
if not df_prior.empty:
    df_prior["sms_vb_count"] = df_prior[["sms_count", "vb_count"]].min(axis=1).astype(int)

combo_order    = ["None(no cont.)", "VB only", "SMS only", "SMS + VB", "Agent Contact", "Never(no cont.)"]
combo_order_v2 = ["None", "Email", "Agent WA", "WA", "WA + Email", "WA + Agent WA", "Never"]
combo_order_v3 = ["None", "Agent Call", "VA", "VA + Agent Call", "Never"]

combo_summaries, chart_totals_combos = {}, {}
combo_client_totals = {}
for tg in tiers:
    sub = df[df["tier_group"] == tg].copy()
    chart_totals_combos[tg] = int(sub.shape[0])
    # N_Records == N_Clients by construction
    combo_client_totals[tg] = int(sub.shape[0])
    sub["sms_count"] = pd.to_numeric(sub["sms_count"], errors="coerce").fillna(0).astype(int)
    sub["vb_count"]  = pd.to_numeric(sub["vb_count"],  errors="coerce").fillna(0).astype(int)
    sub["out_count"]  = pd.to_numeric(sub["out_count"],  errors="coerce").fillna(0).astype(int)


    


    # Per-record total cost = SMS cost + VB cost, using dataset columns when present
    sms_cost_series = (
        pd.to_numeric(sub[sms_cost_col], errors="coerce").fillna(0.0).clip(lower=0)
        if sms_cost_col and sms_cost_col in sub.columns
        else sub["sms_count"].clip(lower=0) * COST_SMS_FALLBACK
    )
    vb_cost_series = (
        pd.to_numeric(sub[vb_cost_col], errors="coerce").fillna(0.0).clip(lower=0)
        if vb_cost_col and vb_cost_col in sub.columns
        else sub["vb_count"].clip(lower=0) * COST_VB_FALLBACK
    )
    out_cost_series = (
        pd.to_numeric(sub[out_cost_col], errors="coerce").fillna(0.0).clip(lower=0)
        if out_cost_col and out_cost_col in sub.columns
        else sub["out_count"].clip(lower=0) * COST_VB_FALLBACK
    )
    # Each bucket's cost = only the channels in its label (Agent Contact = agent only, no SMS/VB)
    sub["__cost"] = np.select(
        [sub["Combo"] == "Agent Contact",
         sub["Combo"] == "SMS + VB",
         sub["Combo"] == "SMS only",
         sub["Combo"] == "VB only"],
        [out_cost_series,
         sms_cost_series + vb_cost_series,
         sms_cost_series,
         vb_cost_series],
        default=0.0
    )

    sub["__tvol"] = pd.to_numeric(sub[tvol_col], errors="coerce") if (tvol_col and tvol_col in sub.columns) else np.nan
    sub["__fb"]   = pd.to_numeric(sub[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in sub.columns) else np.nan

    g = (sub.groupby("Combo")
           .agg(Revenue_per_Record=(dep_col, "mean"),
                Cost_per_Record=("__cost", "mean"),
                N_Records=("Combo", "size"),
                Paying_Customers=("__payer", "sum"),
                Revenue_Sum=(dep_col, "sum"),
                Cost_Sum=("__cost", "sum"),
                Avg_TVOL=("__tvol", "mean"),
                FinalBalance_Sum=("__fb", "sum"))
           .reindex(combo_order)
           .reset_index())
    # Force plain float64 so np.where comparisons never see pd.NA after reindex
    for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
        if _fc in g.columns:
            g[_fc] = pd.to_numeric(g[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
    g["N_Records"] = g["N_Records"].fillna(0)
    g["Paying_Customers"] = g["Paying_Customers"].fillna(0)
    # N_Clients == N_Records since one row per client
    g["N_Clients"] = g["N_Records"]

    g["Profit_per_Record"] = g["Revenue_per_Record"] - g["Cost_per_Record"]
    g["ROI_per_Record"]    = np.where(g["Cost_per_Record"] > 0,
                                      g["Profit_per_Record"] / g["Cost_per_Record"],
                                      np.nan)
    g["Profit_Total"]      = g["Revenue_Sum"] - g["Cost_Sum"]
    g["Profit_per_Payer"]  = np.where(g["Paying_Customers"] > 0,
                                      g["Profit_Total"] / g["Paying_Customers"],
                                      np.nan)

    g["RR_count"] = np.where(g["N_Records"] > 0,
                             g["Paying_Customers"] / g["N_Records"], np.nan)
    g["RR_value"] = np.where(g["FinalBalance_Sum"] > 0,
                             g["Revenue_Sum"] / g["FinalBalance_Sum"], np.nan)
    g["RA_value"] = np.where(g["Paying_Customers"] > 0, g["Revenue_Sum"]/ g["Paying_Customers"],np.nan)


    combo_summaries[tg] = g

# ── v2 (Bot + Email) combo summaries ──────────────────────
combo_summaries_v2, combo_v2_client_totals = {}, {}
for tg in tiers:
    sub = df[df["tier_group"] == tg].copy()
    combo_v2_client_totals[tg] = int(sub.shape[0])

    # v2 cost: WA bot + email only — no agent call cost (out_cost_col excluded intentionally)
    sub["__cost"] = sub["wa_bot_cost"] + sub["email_cost"]
    _none_v2 = sub["Combo_v2"].isin(["None", "Never"])
    _sms_c_v2  = pd.to_numeric(sub[sms_cost_col],  errors="coerce").fillna(0).clip(lower=0) if sms_cost_col  and sms_cost_col  in sub.columns else pd.Series(0.0, index=sub.index)
    _vb_c_v2   = pd.to_numeric(sub[vb_cost_col],   errors="coerce").fillna(0).clip(lower=0) if vb_cost_col   and vb_cost_col   in sub.columns else pd.Series(0.0, index=sub.index)
    _out_c_v2  = pd.to_numeric(sub[out_cost_col],  errors="coerce").fillna(0).clip(lower=0) if out_cost_col  and out_cost_col  in sub.columns else pd.Series(0.0, index=sub.index)
    sub.loc[_none_v2, "__cost"] = _sms_c_v2[_none_v2] + _vb_c_v2[_none_v2] + _out_c_v2[_none_v2]

    sub["__tvol"] = pd.to_numeric(sub[tvol_col], errors="coerce") if (tvol_col and tvol_col in sub.columns) else np.nan
    sub["__fb"]   = pd.to_numeric(sub[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in sub.columns) else np.nan

    g_v2 = (sub.groupby("Combo_v2")
              .agg(Revenue_per_Record=(dep_col, "mean"),
                   Cost_per_Record=("__cost", "mean"),
                   N_Records=("Combo_v2", "size"),
                   Paying_Customers=("__payer", "sum"),
                   Revenue_Sum=(dep_col, "sum"),
                   Cost_Sum=("__cost", "sum"),
                   Avg_TVOL=("__tvol", "mean"),
                   FinalBalance_Sum=("__fb", "sum"))
              .reindex(combo_order_v2)
              .reset_index()
              .rename(columns={"Combo_v2": "Combo"}))
    for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
        if _fc in g_v2.columns:
            g_v2[_fc] = pd.to_numeric(g_v2[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
    g_v2["N_Records"] = g_v2["N_Records"].fillna(0)
    g_v2["Paying_Customers"] = g_v2["Paying_Customers"].fillna(0)
    g_v2["N_Clients"] = g_v2["N_Records"]
    g_v2["Profit_per_Record"] = g_v2["Revenue_per_Record"] - g_v2["Cost_per_Record"]
    g_v2["ROI_per_Record"]    = np.where(g_v2["Cost_per_Record"] > 0,
                                          g_v2["Profit_per_Record"] / g_v2["Cost_per_Record"], np.nan)
    g_v2["Profit_Total"]      = g_v2["Revenue_Sum"] - g_v2["Cost_Sum"]
    g_v2["Profit_per_Payer"]  = np.where(g_v2["Paying_Customers"] > 0,
                                          g_v2["Profit_Total"] / g_v2["Paying_Customers"], np.nan)
    g_v2["RR_count"] = np.where(g_v2["N_Records"] > 0, g_v2["Paying_Customers"] / g_v2["N_Records"], np.nan)
    g_v2["RR_value"] = np.where(g_v2["FinalBalance_Sum"] > 0, g_v2["Revenue_Sum"] / g_v2["FinalBalance_Sum"], np.nan)
    g_v2["RA_value"] = np.where(g_v2["Paying_Customers"] > 0, g_v2["Revenue_Sum"] / g_v2["Paying_Customers"], np.nan)
    combo_summaries_v2[tg] = g_v2

# ── v3 (VA Bot + Agent) combo summaries ──────────────────────
combo_summaries_v3, combo_v3_client_totals = {}, {}
for tg in tiers:
    sub = df[df["tier_group"] == tg].copy()
    combo_v3_client_totals[tg] = int(sub.shape[0])

    sub["__cost"] = (
        sub["va_bot_cost"] +
        pd.to_numeric(sub[out_cost_col], errors="coerce").fillna(0).clip(lower=0)
        if out_cost_col and out_cost_col in sub.columns
        else sub["va_bot_cost"]
    )
    _none_v3 = sub["Combo_v3"] == "None"
    _sms_c_v3 = pd.to_numeric(sub[sms_cost_col], errors="coerce").fillna(0).clip(lower=0) if sms_cost_col and sms_cost_col in sub.columns else pd.Series(0.0, index=sub.index)
    _vb_c_v3  = pd.to_numeric(sub[vb_cost_col],  errors="coerce").fillna(0).clip(lower=0) if vb_cost_col  and vb_cost_col  in sub.columns else pd.Series(0.0, index=sub.index)
    sub.loc[_none_v3, "__cost"] = sub.loc[_none_v3, "wa_bot_cost"] + sub.loc[_none_v3, "email_cost"] + _sms_c_v3[_none_v3] + _vb_c_v3[_none_v3]

    sub["__tvol"] = pd.to_numeric(sub[tvol_col], errors="coerce") if (tvol_col and tvol_col in sub.columns) else np.nan
    sub["__fb"]   = pd.to_numeric(sub[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in sub.columns) else np.nan

    g_v3 = (sub.groupby("Combo_v3")
              .agg(Revenue_per_Record=(dep_col, "mean"),
                   Cost_per_Record=("__cost", "mean"),
                   N_Records=("Combo_v3", "size"),
                   Paying_Customers=("__payer", "sum"),
                   Revenue_Sum=(dep_col, "sum"),
                   Cost_Sum=("__cost", "sum"),
                   Avg_TVOL=("__tvol", "mean"),
                   FinalBalance_Sum=("__fb", "sum"))
              .reindex(combo_order_v3)
              .reset_index()
              .rename(columns={"Combo_v3": "Combo"}))
    for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
        if _fc in g_v3.columns:
            g_v3[_fc] = pd.to_numeric(g_v3[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
    g_v3["N_Records"] = g_v3["N_Records"].fillna(0)
    g_v3["Paying_Customers"] = g_v3["Paying_Customers"].fillna(0)
    g_v3["N_Clients"] = g_v3["N_Records"]
    g_v3["Profit_per_Record"] = g_v3["Revenue_per_Record"] - g_v3["Cost_per_Record"]
    g_v3["ROI_per_Record"]    = np.where(g_v3["Cost_per_Record"] > 0,
                                          g_v3["Profit_per_Record"] / g_v3["Cost_per_Record"], np.nan)
    g_v3["Profit_Total"]      = g_v3["Revenue_Sum"] - g_v3["Cost_Sum"]
    g_v3["Profit_per_Payer"]  = np.where(g_v3["Paying_Customers"] > 0,
                                          g_v3["Profit_Total"] / g_v3["Paying_Customers"], np.nan)
    g_v3["RR_count"] = np.where(g_v3["N_Records"] > 0, g_v3["Paying_Customers"] / g_v3["N_Records"], np.nan)
    g_v3["RR_value"] = np.where(g_v3["FinalBalance_Sum"] > 0, g_v3["Revenue_Sum"] / g_v3["FinalBalance_Sum"], np.nan)
    g_v3["RA_value"] = np.where(g_v3["Paying_Customers"] > 0, g_v3["Revenue_Sum"] / g_v3["Paying_Customers"], np.nan)
    combo_summaries_v3[tg] = g_v3


def add_text_page(pp, title: str, lines: list[str],institution=None):
    import textwrap
    import matplotlib.pyplot as plt
    from matplotlib.transforms import Bbox
    from matplotlib import font_manager as fm

    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")

    # ── Add header (logo + company)
    add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME,institution)

    y = 0.99  # start position
    ax.text(
        0.02, y, title,
        fontsize=12,
        fontproperties=montserrat_bold,
        transform=ax.transAxes
    )
    y -= 0.05

    wrapper = textwrap.TextWrapper(width=95, replace_whitespace=False)

    for line in lines:
        wrapped_lines = wrapper.wrap(line) if line.strip() else [""]
        for wrapped in wrapped_lines:
            if wrapped.strip() == "":
                y -= 0.02
                continue

            header_triggers = [
                "Performance", "Detailed Interpretation", "Analysis", "Summary"
            ]
            is_header = (
                wrapped.endswith(":")
                or any(trigger in wrapped for trigger in header_triggers)
            )

            if is_header:
                # Header text
                text_obj = ax.text(
                    0.02, y, wrapped,
                    fontsize=10.5,
                    fontproperties=montserrat_bold,
                    transform=ax.transAxes,
                    color="#0B6623"
                )
                y -= 0.008

                # ── Dynamic underline
                if wrapped.endswith(":"):
                    fig.canvas.draw()  # render text to measure width
                    bbox: Bbox = text_obj.get_window_extent(renderer=fig.canvas.get_renderer())
                    text_width = bbox.width / fig.get_size_inches()[0] / fig.dpi  # convert to axes fraction
                    underline_end = 0.02 + min(text_width + 0.01, 0.8)  # limit underline to 80%
                    ax.hlines(
                        y, 0.02, underline_end,
                        colors="#00994C", linewidth=2,
                        transform=ax.transAxes
                    )
                    y -= 0.030
                else:
                    y -= 0.020

            else:
                # Regular text — green bullet + black text
                bullet = "•"
                ax.text(
                    0.02, y, bullet,
                    fontsize=10,
                    fontproperties=montserrat_bold,
                    color="#00994C",
                    transform=ax.transAxes
                )
                warning_trigger = "small sample" 
                warning_trigger2 = "too few records"
                is_warning = warning_trigger in wrapped.lower()
                is_warning2 = warning_trigger2 in wrapped.lower()
                ax.text(
                    0.035, y, wrapped.strip(),
                    fontsize=9,
                    fontproperties=montserrat_regular,
                    color="red" if is_warning or is_warning2 else "black",
                    transform=ax.transAxes
                )
                y -= 0.024

            # ── Handle page overflow
            if y < 0.05:
                pp.savefig(fig)
                plt.close(fig)

                fig, ax = plt.subplots(figsize=(8.5, 11))
                ax.axis("off")
                add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME)

                y = 0.99
                ax.text(
                    0.02, y, f"{title} (contd.)",
                    fontsize=12,
                    fontproperties=montserrat_bold,
                    transform=ax.transAxes
                )
                y -= 0.05

    pp.savefig(fig)
    plt.close(fig)


def add_executive_summary_page(pp, df, dep_col, sms_cost_col, vb_cost_col, out_cost_col,
                               tvol_col, final_bal_col, date_from, date_to, deposit_to,
                               institutions):
    import textwrap

    fig, ax = plt.subplots(figsize=(8.5, 11), dpi=100)
    ax.axis("off")
    fig.patch.set_facecolor("white")
    add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME)

    GREEN  = "#0B6623"
    DARK   = "#1a1a1a"
    GRAY   = "#555555"
    LGRAY  = "#888888"
    ACCENT = "#2F6EA5"

    def section_header(y, text):
        ax.text(0.04, y, text, transform=ax.transAxes,
                fontsize=9.5, fontproperties=montserrat_bold, color=GREEN)
        line = plt.Line2D([0.04, 0.96], [y - 0.011, y - 0.011],
                          transform=ax.transAxes, color=GREEN, linewidth=0.6, alpha=0.45)
        ax.add_line(line)
        return y - 0.026

    def body_text(y, text, indent=0.04, wrap_width=104, color=DARK, font=None):
        fp = font or montserrat_regular
        for line in textwrap.wrap(text, width=wrap_width):
            ax.text(indent, y, line, transform=ax.transAxes,
                    fontsize=7.5, fontproperties=fp, color=color)
            y -= 0.019
        return y

    def kv_row(y, label, value, label_x=0.04, value_x=0.42, bold_value=True):
        ax.text(label_x, y, label, transform=ax.transAxes,
                fontsize=7.5, fontproperties=montserrat_regular, color=GRAY)
        ax.text(value_x, y, value, transform=ax.transAxes,
                fontsize=7.5,
                fontproperties=montserrat_bold if bold_value else montserrat_regular,
                color=DARK)
        return y - 0.021

    def stat_block(ax, fig_x, fig_y, label, value, sub=None):
        ax.text(fig_x, fig_y, value, transform=fig.transFigure,
                fontsize=10, fontproperties=montserrat_bold, color=ACCENT,
                ha="center", va="center")
        ax.text(fig_x, fig_y - 0.025, label, transform=fig.transFigure,
                fontsize=6.5, fontproperties=montserrat_regular, color=GRAY,
                ha="center", va="center")
        if sub:
            ax.text(fig_x, fig_y - 0.038, sub, transform=fig.transFigure,
                    fontsize=6.0, fontproperties=montserrat_italic, color=LGRAY,
                    ha="center", va="center")

    # ── compute live numbers ──────────────────────────────────────────────────
    total_records   = len(df)
    n_institutions  = df["institution"].nunique() if "institution" in df.columns else len(institutions)
    inst_names      = sorted(df["institution"].dropna().unique().tolist()) if "institution" in df.columns else institutions

    dep_vals        = pd.to_numeric(df[dep_col], errors="coerce").fillna(0)
    total_deposits  = dep_vals.sum()
    paying_clients  = int((dep_vals > 0).sum())

    tvol_vals       = pd.to_numeric(df[tvol_col], errors="coerce").fillna(0) if tvol_col and tvol_col in df.columns else pd.Series([0.0] * len(df))
    fb_vals         = pd.to_numeric(df[final_bal_col], errors="coerce").fillna(0) if final_bal_col and final_bal_col in df.columns else pd.Series([0.0] * len(df))
    total_outstanding = fb_vals.sum() if fb_vals.sum() > 0 else tvol_vals.sum()
    portfolio_value   = tvol_vals.sum()

    recovery_rate   = (total_deposits / total_outstanding) if total_outstanding > 0 else 0.0

    sms_cost  = pd.to_numeric(df[sms_cost_col], errors="coerce").fillna(0).sum() if sms_cost_col and sms_cost_col in df.columns else 0.0
    vb_cost   = pd.to_numeric(df[vb_cost_col],  errors="coerce").fillna(0).sum() if vb_cost_col  and vb_cost_col  in df.columns else 0.0
    out_cost  = pd.to_numeric(df[out_cost_col], errors="coerce").fillna(0).sum() if out_cost_col and out_cost_col in df.columns else 0.0
    va_cost   = pd.to_numeric(df.get("va_bot_cost", 0), errors="coerce").fillna(0).sum() if "va_bot_cost" in df.columns else 0.0
    em_cost   = pd.to_numeric(df.get("email_cost",  0), errors="coerce").fillna(0).sum() if "email_cost"  in df.columns else 0.0
    total_cost = sms_cost + vb_cost + out_cost + va_cost + em_cost

    # Revenue: institution-specific commissions are already in the query as daily_revenue-like col
    # Use dep_col sum as proxy base; actual commission already embedded in chart_df Revenue_Sum
    # Best estimate: revenue = total_deposits commission. We derive it from the data query commission col if present.
    rev_col_candidates = ["revenue", "total_revenue", "commission", "daily_commission"]
    rev_col = next((c for c in rev_col_candidates if c in df.columns), None)
    if rev_col:
        total_revenue = pd.to_numeric(df[rev_col], errors="coerce").fillna(0).sum()
    else:
        # Fallback: use 18% flat estimate (mid-range commission), clearly labelled as estimated
        total_revenue = total_deposits * 0.18
    total_profit    = total_revenue - total_cost
    overall_roi     = (total_revenue / total_cost) if total_cost > 0 else float("nan")

    # Period
    extended = deposit_to and deposit_to > date_to
    period_str = f"{date_from}  to  {date_to}"
    if extended:
        period_str += f"  (deposits to {deposit_to})"

    inst_str = ", ".join(inst_names) if inst_names else "All Institutions"
    if len(inst_str) > 80:
        inst_str = f"{n_institutions} institutions"

    # ── layout ───────────────────────────────────────────────────────────────
    y = 0.925

    ax.text(0.04, y, "Executive Summary",
            transform=ax.transAxes, fontsize=12.5,
            fontproperties=montserrat_bold, color=DARK)
    y -= 0.012
    ax.text(0.04, y,
            f"Prepared by Fintech Solutions Services  |  {date_from} to {date_to}",
            transform=ax.transAxes, fontsize=7.5,
            fontproperties=montserrat_italic, color=LGRAY)
    y -= 0.026

    # ── Data Scope ───────────────────────────────────────────────────────────
    y = section_header(y, "Data Scope")
    y = kv_row(y, "Reporting period",    period_str)
    y = kv_row(y, "Institutions covered", inst_str)
    y = kv_row(y, "Total records",        f"{total_records:,}")
    y = kv_row(y, "Portfolio value",      fmt_money_short(portfolio_value))
    y = kv_row(y, "Outstanding balance",  fmt_money_short(total_outstanding))
    y -= 0.004

    # ── Period Highlights ────────────────────────────────────────────────────
    y = section_header(y, "Period Highlights")
    rev_label = "Total Revenue (est.)" if not rev_col else "Total Revenue"
    for label, value in [
        ("Total Deposits",  fmt_money_short(total_deposits)),
        (rev_label,         fmt_money_short(total_revenue)),
        ("Total Cost",      fmt_money_short(total_cost)),
        ("Net Profit",      fmt_money_short(total_profit)),
        ("Overall ROI",     fmt_roi(overall_roi)),
    ]:
        ax.text(0.04, y, label, transform=ax.transAxes,
                fontsize=7.5, fontproperties=montserrat_regular, color=GRAY)
        ax.text(0.42, y, value, transform=ax.transAxes,
                fontsize=7.5, fontproperties=montserrat_bold, color=ACCENT)
        y -= 0.021
    y -= 0.004

    # ── Recovery overview ─────────────────────────────────────────────────────
    y = section_header(y, "Recovery Overview")
    y = kv_row(y, "Paying customers",  f"{paying_clients:,}  ({fmt_pct(paying_clients / total_records) if total_records else 'N/A'} of records)")
    y = kv_row(y, "Recovery rate",     f"{fmt_pct(recovery_rate)}  (deposits / outstanding balance)")
    y = kv_row(y, "Avg. deposit / payer",
                f"{fmt_money_short(total_deposits / paying_clients) if paying_clients else 'N/A'}")
    y -= 0.004

    # ── Key Findings ─────────────────────────────────────────────────────────
    y = section_header(y, "Key Findings")

    sms_records   = int((pd.to_numeric(df.get("sms_count", 0), errors="coerce").fillna(0) > 0).sum())
    vb_records    = int((pd.to_numeric(df.get("vb_count",  0), errors="coerce").fillna(0) > 0).sum())
    va_records    = int((pd.to_numeric(df.get("va_bot_count",  0), errors="coerce").fillna(0) > 0).sum())
    wa_records    = int((pd.to_numeric(df.get("wa_bot_count",  0), errors="coerce").fillna(0) > 0).sum())
    agent_records = int((pd.to_numeric(df.get("agent_contact_count", 0), errors="coerce").fillna(0) > 0).sum())

    findings = []
    findings.append(
        f"{total_records:,} loan records across {n_institutions} institution(s) were active in the portfolio "
        f"during this period, of which {paying_clients:,} ({fmt_pct(paying_clients / total_records) if total_records else 'N/A'}) made at least one deposit."
    )
    if sms_records:
        findings.append(f"SMS outreach reached {sms_records:,} records. Total SMS spend: {fmt_money_short(sms_cost)}.")
    if vb_records:
        findings.append(f"Voice Broadcast (VB) was deployed across {vb_records:,} records at a total cost of {fmt_money_short(vb_cost)}.")
    if va_records:
        findings.append(f"VA Bot (AI voice agent) engaged {va_records:,} records, contributing {fmt_money_short(va_cost)} in cost.")
    if wa_records:
        findings.append(f"WhatsApp Bot (WA) was used for {wa_records:,} records.")
    if agent_records:
        findings.append(f"Human agent contact was made on {agent_records:,} records at a total outbound cost of {fmt_money_short(out_cost)}.")
    if total_cost > 0:
        findings.append(
            f"Total outreach cost across all channels was {fmt_money_short(total_cost)}, "
            f"generating an estimated {fmt_money_short(total_revenue)} in commission revenue "
            f"(ROI: {fmt_roi(overall_roi)})."
        )

    for finding in findings:
        y = body_text(y, f"- {finding}", indent=0.055, wrap_width=98)
        y -= 0.002
    y -= 0.004

    # ── Caveats ───────────────────────────────────────────────────────────────
    y = section_header(y, "Caveats & Limitations")
    caveats = [
        "Recovery rates are based on deposits logged in BigQuery for the stated period and may not include payments "
        "processed after the report cut-off date.",
        "Revenue figures use contractual commission rates per institution and are estimates where an exact commission "
        "column is absent from the dataset.",
        "Cost figures cover SMS, VB, outbound agent, and VA Bot where available; WhatsApp Bot costs are excluded.",
    ]
    for caveat in caveats:
        y = body_text(y, f"- {caveat}", indent=0.055, wrap_width=98, color=GRAY)
        y -= 0.002

    pp.savefig(fig, facecolor=fig.get_facecolor(), bbox_inches=None, pad_inches=0)
    plt.close(fig)


def add_contact_methods_comparison_page(pp, df_cur, df_prior, date_from, date_to,
                                        prior_date_from, prior_date_to):
    """
    Total volume per contact method, current period vs. the immediately
    preceding period of equal length — broken out per institution, one
    block per institution, spilling across as many pages as needed
    (green = growth/new, red = decline).
    """
    GREEN = "#0B6623"
    RED   = "#B00020"
    DARK  = "#1a1a1a"
    GRAY  = "#555555"
    LGRAY = "#888888"

    METHODS = [
        # Raw period totals — not sms_count/vb_count, which resolve to a per-week
        # AVERAGE rate (SAFE_DIVIDE by effective_weeks) whenever "weekly" mode is
        # auto-detected, which would mismatch the true-total columns used below.
        ("SMS",            "total_weekly_sms_success"),
        ("Voice Blast",    "total_weekly_vb_outbound"),
        ("Agent Calls",    "agent_call_count"),
        ("Agent WhatsApp", "agent_wa_count"),
        ("Bot WhatsApp",   "wa_bot_count"),
        ("VA Bot",         "va_bot_count"),
        ("Email",          "email_count"),
    ]

    def method_sum(df_x, col):
        if df_x is None or df_x.empty or col not in df_x.columns:
            return 0
        return int(pd.to_numeric(df_x[col], errors="coerce").fillna(0).sum())

    has_inst_col = ("institution" in df_cur.columns) and df_cur["institution"].notna().any()
    institutions = sorted(df_cur["institution"].dropna().unique().tolist()) if has_inst_col else [None]

    LABEL_X, CUR_X, PRIOR_X, DELTA_X = 0.06, 0.52, 0.72, 0.92
    BOTTOM_Y = 0.09
    ROW_H    = 0.024
    BLOCK_H  = 0.035 + 0.035 + len(METHODS) * ROW_H + 0.035  # inst header + col header + rows + gap

    state = {"fig": None, "ax": None, "y": 0.0}

    def start_page(continued):
        fig, ax = plt.subplots(figsize=(8.5, 11), dpi=100)
        ax.axis("off")
        fig.patch.set_facecolor("white")
        add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME)

        y = 0.925
        title = "Contact Methods — Period Comparison" + (" (continued)" if continued else "")
        ax.text(0.04, y, title, transform=ax.transAxes, fontsize=12.5,
                fontproperties=montserrat_bold, color=DARK)
        y -= 0.012
        ax.text(0.04, y,
                f"Current: {date_from} to {date_to}   |   Prior: {prior_date_from} to {prior_date_to}",
                transform=ax.transAxes, fontsize=7.5,
                fontproperties=montserrat_italic, color=LGRAY)
        y -= 0.03

        state["fig"], state["ax"], state["y"] = fig, ax, y

    def finish_page():
        pp.savefig(state["fig"], facecolor=state["fig"].get_facecolor(), bbox_inches=None, pad_inches=0)
        plt.close(state["fig"])

    start_page(continued=False)

    for inst in institutions:
        if state["y"] - BLOCK_H < BOTTOM_Y:
            finish_page()
            start_page(continued=True)
        ax, y = state["ax"], state["y"]

        inst_label = inst if inst is not None else "All Institutions"
        if has_inst_col:
            df_cur_i   = df_cur[df_cur["institution"] == inst]
            df_prior_i = (df_prior[df_prior["institution"] == inst]
                          if df_prior is not None and "institution" in df_prior.columns else df_prior)
        else:
            df_cur_i, df_prior_i = df_cur, df_prior

        # Institution header
        ax.text(LABEL_X, y, inst_label, transform=ax.transAxes, fontsize=9.5,
                fontproperties=montserrat_bold, color=GREEN)
        y -= 0.010
        ax.add_line(plt.Line2D([0.04, 0.96], [y, y], transform=ax.transAxes,
                               color=GREEN, linewidth=0.6, alpha=0.45))
        y -= 0.022

        # Column header
        ax.text(LABEL_X, y, "Method",  transform=ax.transAxes, fontsize=7.5,
                fontproperties=montserrat_bold, color=GRAY)
        ax.text(CUR_X,   y, "Current", transform=ax.transAxes, fontsize=7.5,
                fontproperties=montserrat_bold, color=GRAY, ha="right")
        ax.text(PRIOR_X, y, "Prior",   transform=ax.transAxes, fontsize=7.5,
                fontproperties=montserrat_bold, color=GRAY, ha="right")
        ax.text(DELTA_X, y, "Change",  transform=ax.transAxes, fontsize=7.5,
                fontproperties=montserrat_bold, color=GRAY, ha="right")
        y -= 0.008
        ax.add_line(plt.Line2D([0.04, 0.96], [y, y], transform=ax.transAxes,
                               color="#DDDDDD", linewidth=0.6))
        y -= ROW_H

        for label, col in METHODS:
            cur   = method_sum(df_cur_i, col)
            prior = method_sum(df_prior_i, col)
            if prior > 0:
                pct   = (cur - prior) / prior * 100.0
                delta = f"{pct:+.1f}%"
                color = GREEN if pct >= 0 else RED
            elif cur > 0:
                delta = "New"
                color = GREEN
            else:
                delta = "—"
                color = LGRAY

            ax.text(LABEL_X, y, label, transform=ax.transAxes, fontsize=8,
                    fontproperties=montserrat_regular, color=DARK)
            ax.text(CUR_X,   y, f"{cur:,}", transform=ax.transAxes, fontsize=8,
                    fontproperties=montserrat_bold, color=DARK, ha="right")
            ax.text(PRIOR_X, y, f"{prior:,}", transform=ax.transAxes, fontsize=8,
                    fontproperties=montserrat_regular, color=GRAY, ha="right")
            ax.text(DELTA_X, y, delta, transform=ax.transAxes, fontsize=8,
                    fontproperties=montserrat_bold, color=color, ha="right")
            y -= ROW_H

        y -= 0.035  # gap before next institution block
        state["y"] = y

    ax = state["ax"]
    footnote_y = max(state["y"] - 0.005, 0.03)
    ax.text(0.04, footnote_y,
            "Change reflects total volume vs. the immediately preceding period of equal length.",
            transform=ax.transAxes, fontsize=6.5,
            fontproperties=montserrat_italic, color=LGRAY)

    finish_page()


def add_overview_page(pp):
    import textwrap

    fig, ax = plt.subplots(figsize=(8.5, 11), dpi=100)
    ax.axis("off")
    fig.patch.set_facecolor("white")
    add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME)

    GREEN = "#0B6623"
    DARK  = "#1a1a1a"
    GRAY  = "#444444"

    def section_header(y, text):
        ax.text(0.04, y, text, transform=ax.transAxes,
                fontsize=9.0, fontproperties=montserrat_bold, color=GREEN)
        line = plt.Line2D([0.04, 0.96], [y - 0.010, y - 0.010],
                          transform=ax.transAxes, color=GREEN, linewidth=0.6, alpha=0.45)
        ax.add_line(line)
        return y - 0.022

    def body_text(y, text, indent=0.04, wrap_width=102):
        for line in textwrap.wrap(text, width=wrap_width):
            ax.text(indent, y, line, transform=ax.transAxes,
                    fontsize=7.5, fontproperties=montserrat_regular, color=DARK)
            y -= 0.018
        return y

    def definition(y, label, desc, wrap_width=80):
        lines = textwrap.wrap(desc, width=wrap_width)
        ax.text(0.04, y, label + ":", transform=ax.transAxes,
                fontsize=7.5, fontproperties=montserrat_bold, color=DARK)
        for i, line in enumerate(lines):
            ax.text(0.27, y - i * 0.017, line, transform=ax.transAxes,
                    fontsize=7.5, fontproperties=montserrat_regular, color=GRAY)
        return y - max(1, len(lines)) * 0.017 - 0.003

    y = 0.930

    # Page title
    ax.text(0.04, y, "Report Overview & Methodology",
            transform=ax.transAxes, fontsize=11.5,
            fontproperties=montserrat_bold, color=DARK)
    y -= 0.028

    # About
    y = section_header(y, "About This Report")
    y = body_text(y,
        "This report measures the effectiveness of each recovery contact method deployed across "
        "assigned loan portfolios during the selected period. It shows how different outreach "
        "strategies — from automated messaging to AI-driven conversations and human agent contact "
        "— translate into actual deposit recovery, and at what cost.")
    y -= 0.006

    # Contact Methods
    y = section_header(y, "Contact Methods")
    y = definition(y, "SMS",
        "Automated text message reminders sent to customers at scale.")
    y = definition(y, "VB  (Voice Broadcast)",
        "Pre-recorded automated voice calls delivered to customers without a live agent.")
    y = definition(y, "VA Bot  (Voice Agent)",
        "An AI-trained voice bot that holds natural spoken conversations with customers, "
        "designed to be indistinguishable from a human agent in tone and response.")
    y = definition(y, "WA Bot",
        "An AI agent trained to engage customers over WhatsApp in natural, human-like written conversation.")
    y = definition(y, "Agent Contact",
        "Direct outreach by a human recovery agent via phone call or WhatsApp message.")
    y = definition(y, "Email",
        "Automated email outreach sent to customers in the assigned portfolio.")
    y -= 0.006

    # Combo Strategies
    y = section_header(y, "Combo Strategies")
    y = definition(y, "Combo 1  (SMS + VB)",
        "Customers contacted through both SMS and Voice Broadcast within the period.")
    y = definition(y, "Combo 2  (WA + Email)",
        "Customers engaged via both WhatsApp Agent and Email outreach.")
    y = definition(y, 'Combo 3  (The Triage)',
        "VA Bot paired with human Agent Contact. An in-house project measuring how effectively "
        "AI voice conversations, when followed up by a human agent, improve recovery outcomes "
        "compared to either channel alone.")
    y -= 0.006

    # Key Metrics
    y = section_header(y, "Key Metrics & How They Are Measured")
    y = definition(y, "Recovery Rate",
        "Total deposits collected divided by total outstanding balance assigned. Measures what "
        "proportion of the assigned book was recovered in the period.")
    y = definition(y, "Revenue",
        "Commission earned on deposits collected, calculated at each institution's contracted rate.")
    y = definition(y, "Cost",
        "Total outreach spend — SMS unit cost + VB call cost + agent and outbound call cost.")
    y = definition(y, "Profit per Record",
        "Revenue minus cost, divided by the number of records in the segment. Shows which "
        "contact strategy delivers the best return per customer.")
    y = definition(y, "ROI",
        "Return on Investment. Revenue divided by cost. An ROI of 2.5x means every N1 spent "
        "in outreach generated N2.50 in commission income.")
    y = definition(y, "DPD  (Days Past Due)",
        "How many days a loan has been in arrears. Used to segment portfolios by the age of "
        "debt and assess which strategies work best at different delinquency stages.")
    y = definition(y, "Tier",
        "Customer segmentation tier based on loan value and behavioural risk profile, used to "
        "assign the most appropriate contact strategy.")
    y = definition(y, "Cum. Recoveries",
        "Cumulative count of all contact attempts across every channel since the portfolio was assigned.")

    pp.savefig(fig, facecolor=fig.get_facecolor(), bbox_inches=None, pad_inches=0)
    plt.close(fig)


def add_chart_analysis(pp, method_name: str, tier: str, chart_df: pd.DataFrame, institution=None):
    if chart_df.empty:
        return

    is_combo = "Combo" in chart_df.columns
    df = chart_df.copy()
    xcol = "Combo" if is_combo else "Count"
    df = df.sort_values(xcol).reset_index(drop=True)

    # ── Core aggregates (exclude empty-record rows from stats) ──
    valid        = df[df["N_Records"].fillna(0) > 0].copy()
    total_n      = safe_int(df["N_Records"].sum())        if "N_Records"        in df.columns else 0
    total_payers = safe_int(df["Paying_Customers"].sum()) if "Paying_Customers" in df.columns else 0
    overall_rr   = total_payers / total_n if total_n > 0 else 0.0

    profits = pd.to_numeric(valid["Profit_per_Record"], errors="coerce").dropna()
    rois    = pd.to_numeric(valid["ROI_per_Record"],    errors="coerce").dropna()
    rr_vals = pd.to_numeric(valid["RR_count"],          errors="coerce").dropna()

    avg_profit   = float(profits.mean()) if not profits.empty else 0.0
    avg_roi      = float(rois.mean())    if not rois.empty    else 0.0
    std_profit   = float(profits.std(ddof=1)) if len(profits) > 1 else 0.0
    cv_profit    = abs(std_profit / avg_profit) if avg_profit != 0 else float("nan")
    profit_range = float(profits.max() - profits.min()) if len(profits) > 1 else 0.0

    def _best_label(s):
        return str(valid.loc[s.idxmax(), xcol]) if not s.empty else "N/A"
    def _worst_label(s):
        return str(valid.loc[s.idxmin(), xcol]) if not s.empty else "N/A"

    total_rev  = pd.to_numeric(df["Revenue_Sum"],  errors="coerce").fillna(0).sum() if "Revenue_Sum"  in df.columns else 0.0
    total_cost = pd.to_numeric(df["Cost_Sum"],     errors="coerce").fillna(0).sum() if "Cost_Sum"     in df.columns else 0.0
    rev_cost_ratio = total_rev / total_cost if total_cost > 0 else float("nan")

    # ── Header ──────────────────────────────────────────────────────
    lines = []
    lines.append(f"{method_name} Performance — {tier}")
    lines.append(f"Sample: {total_n:,} records  |  Paying Clients: {total_payers:,}  |  Overall Activation: {fmt_pct(overall_rr)}")
    lines.append(f"Avg Profit/Record: {fmt_money_short(avg_profit)}  |  Avg ROI: {fmt_roi(avg_roi)}  |  Profit Spread: {fmt_money_short(profit_range)}")

    if not (isinstance(cv_profit, float) and np.isnan(cv_profit)):
        if cv_profit < 0.25:
            cv_label = "very consistent — performance is stable across groups"
        elif cv_profit < 0.5:
            cv_label = "moderate variation — some groups diverge from average"
        elif cv_profit < 1.0:
            cv_label = "high variation — performance differs significantly across groups"
        else:
            cv_label = "very high variation — outcomes are polarised across groups"
        lines.append(f"Profit Consistency (CV = {cv_profit:.2f}): {cv_label}.")

    if not (isinstance(rev_cost_ratio, float) and np.isnan(rev_cost_ratio)) and rev_cost_ratio > 0:
        lines.append(f"Overall Rev/Cost Ratio: {rev_cost_ratio:.2f}x — every ₦1 in collection cost recovered ₦{rev_cost_ratio:.2f} in revenue.")

    lines.append("")
    if not profits.empty:
        lines.append(f"  Best Profit/Record:  {_best_label(profits)} → {fmt_money_short(float(profits.max()))}")
    if not rois.empty:
        lines.append(f"  Best ROI:            {_best_label(rois)} → {fmt_roi(float(rois.max()))}")
    if not rr_vals.empty:
        lines.append(f"  Best Recovery Rate:  {_best_label(rr_vals)} → {fmt_pct(float(rr_vals.max()))}")
    if len(profits) > 1:
        lines.append(f"  Weakest Profit:      {_worst_label(profits)} → {fmt_money_short(float(profits.min()))}")
    lines.append("")

    # ─────────────────────────── COMBO ──────────────────────────────
    if is_combo:
        none_rows   = df[df["Combo"] == "None"]
        none_profit = float(none_rows["Profit_per_Record"].mean()) if not none_rows.empty else float("nan")

        profitable_n   = int((profits > 0).sum())
        unprofitable_n = len(valid) - profitable_n
        lines.append(f"Groups in profit: {profitable_n}  |  Below break-even: {unprofitable_n}")

        if total_payers > 0 and "Paying_Customers" in valid.columns:
            top2 = pd.to_numeric(valid["Paying_Customers"], errors="coerce").fillna(0).nlargest(2).sum()
            lines.append(f"Payer concentration: top 2 groups hold {fmt_pct(top2 / total_payers)} of all paying clients.")

        # Synergy / anti-synergy detection for combo groups
        for _, vrow in valid.iterrows():
            combo = str(vrow[xcol])
            if "+" not in combo:
                continue
            parts = [p.strip() for p in combo.split("+")]
            part_profits = []
            for p in parts:
                pm = valid[valid[xcol] == p]
                if not pm.empty:
                    pv = safe_num(pm.iloc[0]["Profit_per_Record"])
                    part_profits.append(pv)
            if len(part_profits) == len(parts):
                cp = safe_num(vrow["Profit_per_Record"])
                best_part = max(part_profits)
                if cp > best_part and best_part > 0:
                    pct = (cp - best_part) / best_part
                    lines.append(f"Synergy: '{combo}' outperforms its strongest individual component by {fmt_pct(pct)}.")
                elif cp < min(part_profits):
                    lines.append(f"Anti-synergy: '{combo}' underperforms its weakest individual component — possible overlap or contact fatigue.")

        lines.append("")
        lines.append("Per-Group Detail:")
        lines.append("")

        for _, row in df.iterrows():
            combo    = str(row[xcol])
            profit   = safe_num(row["Profit_per_Record"])
            roi      = safe_num(row["ROI_per_Record"])
            rr       = safe_num(row["RR_count"])
            n_rec    = safe_int(row["N_Records"])
            payers   = safe_int(row["Paying_Customers"])
            ra_val   = safe_num(row["RA_value"])   if "RA_value"   in row.index else 0.0
            rev_row  = safe_num(row["Revenue_Sum"]) if "Revenue_Sum" in row.index else 0.0
            cost_row = safe_num(row["Cost_Sum"])    if "Cost_Sum"    in row.index else 0.0

            if n_rec == 0:
                lines.append(f"  {combo}: no records in this tier")
                lines.append("")
                continue

            activation = payers / n_rec
            delta_avg  = profit - avg_profit
            ds         = "+" if delta_avg >= 0 else ""
            rc_str     = f" | Rev/Cost: {rev_row/cost_row:.2f}x" if cost_row > 0 else ""

            if n_rec < 30:     strength = "very small sample — low confidence"
            elif n_rec < 100:  strength = "small sample — interpret cautiously"
            elif n_rec < 500:  strength = "moderate sample"
            elif n_rec < 2000: strength = "good sample — reliable"
            else:              strength = "large sample — statistically strong"

            lines.append(f"{combo}  [{n_rec:,} records | {strength}]:")
            lines.append(f"  Profit/Record: {fmt_money_short(profit)} ({ds}{fmt_money_short(delta_avg)} vs avg) | ROI: {fmt_roi(roi)} | Recovery Rate: {fmt_pct(rr)}{rc_str}")
            lines.append(f"  Paying Clients: {payers:,} / {n_rec:,}  ({fmt_pct(activation)} activation)")

            if not (isinstance(none_profit, float) and np.isnan(none_profit)) and combo != "None":
                prem = profit - none_profit
                ps   = "+" if prem >= 0 else ""
                lines.append(f"  Channel premium over None: {ps}{fmt_money_short(prem)}")

            if ra_val > 0:
                lines.append(f"  Avg Revenue per Paying Client: {fmt_money_short(ra_val)}")

            # Break-even activation rate
            if cost_row > 0 and payers > 0 and rev_row > 0:
                rev_per_payer = rev_row / payers
                be_rate = (cost_row / n_rec) / rev_per_payer
                if 0 < be_rate < 1:
                    flag = "above" if activation >= be_rate else "below"
                    lines.append(f"  Break-even activation: {fmt_pct(be_rate)} (current {fmt_pct(activation)} — {flag})")

            if roi >= 2.0 and profit > avg_profit:
                verdict = "Exceptional — 2x+ ROI with above-average profit margin."
            elif roi >= 1.5 and profit > 0:
                verdict = "High efficiency — strong ROI and positive margin."
            elif roi >= 1.0 and profit >= avg_profit:
                verdict = "Profitable and at or above group average."
            elif roi >= 1.0 and profit > 0:
                verdict = "Profitable but below average — ROI covers cost, margin is thin."
            elif profit > 0:
                verdict = "Revenue positive but cost-heavy — contact spend outpaces incremental recovery."
            else:
                verdict = "Below break-even — cost of contact exceeds revenue generated at this tier."

            lines.append(f"  Verdict: {verdict}")
            lines.append("")

    # ─────────────────────────── COUNT ──────────────────────────────
    else:
        vs         = valid.sort_values("Count").reset_index(drop=True)
        c_vals     = pd.to_numeric(vs["Count"],             errors="coerce").values
        c_profits  = pd.to_numeric(vs["Profit_per_Record"], errors="coerce").values
        c_rois     = pd.to_numeric(vs["ROI_per_Record"],    errors="coerce").values

        nz_mask    = c_vals > 0
        nz_profits = c_profits[nz_mask]

        peak_p_idx = int(np.nanargmax(c_profits)) if len(c_profits) and not np.all(np.isnan(c_profits)) else None
        peak_r_idx = int(np.nanargmax(c_rois))    if len(c_rois)    and not np.all(np.isnan(c_rois))    else None
        peak_p_c   = int(c_vals[peak_p_idx]) if peak_p_idx is not None else None
        peak_r_c   = int(c_vals[peak_r_idx]) if peak_r_idx is not None else None

        trend_str = None
        if len(nz_profits) >= 3:
            mid = len(nz_profits) // 2
            fh, sh = np.nanmean(nz_profits[:mid]), np.nanmean(nz_profits[mid:])
            if sh < fh * 0.85:
                trend_str = "clear diminishing returns — profit declines at higher contact frequencies"
            elif sh > fh * 1.1:
                trend_str = "increasing returns — higher frequency drives progressively better outcomes"
            else:
                trend_str = "flat dose-response — contact frequency has limited incremental impact"

        # Marginal gains between adjacent count buckets
        marginals = {}
        for i in range(1, len(c_vals)):
            if not (np.isnan(c_profits[i]) or np.isnan(c_profits[i - 1])):
                marginals[int(c_vals[i])] = c_profits[i] - c_profits[i - 1]

        base_profit_val = float(df.loc[df["Count"] == 0, "Profit_per_Record"].mean()) if 0 in df["Count"].values else float("nan")

        lines.append("Dose-Response Analysis:")
        if peak_p_c is not None:
            lines.append(f"Peak profit at {peak_p_c} {method_name}(s)/record: {fmt_money_short(float(c_profits[peak_p_idx]))}")
        if peak_r_c is not None and peak_r_c != peak_p_c:
            lines.append(f"Peak ROI at {peak_r_c} {method_name}(s): {fmt_roi(float(c_rois[peak_r_idx]))} — diverges from peak profit; efficiency peaks before revenue does.")
        if trend_str:
            lines.append(f"Trend: {trend_str}.")
        if marginals:
            best_m  = max(marginals, key=lambda k: marginals[k])
            worst_m = min(marginals, key=lambda k: marginals[k])
            bms = "+" if marginals[best_m] >= 0 else ""
            wms = "+" if marginals[worst_m] >= 0 else ""
            lines.append(f"Largest marginal gain: at count {best_m} ({bms}{fmt_money_short(marginals[best_m])}/record).")
            lines.append(f"Largest marginal drop: at count {worst_m} ({wms}{fmt_money_short(marginals[worst_m])}/record).")
        lines.append("")
        lines.append("Per-Count Detail:")
        lines.append("")

        for _, row in df.iterrows():
            c        = int(row["Count"])
            profit   = safe_num(row["Profit_per_Record"])
            roi      = safe_num(row["ROI_per_Record"])
            rr       = safe_num(row["RR_count"])
            n_rec    = safe_int(row["N_Records"])
            payers   = safe_int(row["Paying_Customers"])
            rev_row  = safe_num(row["Revenue_Sum"]) if "Revenue_Sum" in row.index else 0.0
            cost_row = safe_num(row["Cost_Sum"])    if "Cost_Sum"    in row.index else 0.0

            if n_rec == 0:
                lines.append(f"  {c} {method_name}(s): no records")
                lines.append("")
                continue

            activation = payers / n_rec
            delta_avg  = profit - avg_profit
            ds         = "+" if delta_avg >= 0 else ""
            marg_str   = ""
            if c in marginals:
                ms = "+" if marginals[c] >= 0 else ""
                marg_str = f" | Marginal Delta: {ms}{fmt_money_short(marginals[c])}"
            rc_str     = f" | Rev/Cost: {rev_row/cost_row:.2f}x" if cost_row > 0 else ""
            peak_flag  = ""
            if peak_p_c is not None and peak_r_c is not None and c == peak_p_c == peak_r_c:
                peak_flag = " — peak profit and ROI"
            elif peak_p_c is not None and c == peak_p_c:
                peak_flag = " — peak profit"
            elif peak_r_c is not None and c == peak_r_c:
                peak_flag = " — peak ROI"

            if n_rec < 30:     strength = "very small sample"
            elif n_rec < 100:  strength = "small sample"
            elif n_rec < 500:  strength = "moderate sample"
            elif n_rec < 2000: strength = "good sample"
            else:              strength = "large sample"

            if c == 0:
                lines.append(f"0 {method_name}s  [{n_rec:,} records | {strength}] — zero-contact baseline:")
                lines.append(f"  Profit/Record: {fmt_money_short(profit)} | ROI: {fmt_roi(roi)} | Recovery Rate: {fmt_pct(rr)}")
                lines.append(f"  Paying Clients: {payers:,} ({fmt_pct(activation)} activation) — natural repayment without intervention.")
                lines.append("")
                continue

            lines.append(f"{c} {method_name}(s){peak_flag}  [{n_rec:,} records | {strength}]:")
            lines.append(f"  Profit/Record: {fmt_money_short(profit)} ({ds}{fmt_money_short(delta_avg)} vs avg){marg_str}{rc_str}")
            lines.append(f"  ROI: {fmt_roi(roi)} | Recovery Rate: {fmt_pct(rr)} | Activation: {fmt_pct(activation)}")

            if not (isinstance(base_profit_val, float) and np.isnan(base_profit_val)):
                uplift = profit - base_profit_val
                us = "+" if uplift >= 0 else ""
                lines.append(f"  Uplift vs. zero-contact baseline: {us}{fmt_money_short(uplift)}/record")

            if roi >= 2.0 and profit > avg_profit:
                verdict = "Exceptional — 2x+ ROI with above-average profit."
            elif profit > 0 and roi >= 1.2:
                verdict = "Strong — solid profit with efficient cost conversion."
            elif profit > 0 and roi >= 1.0:
                verdict = "Profitable — cost covered, returns are moderate."
            elif profit > 0:
                verdict = "Profitable but cost-heavy — revenue grows but per-unit efficiency declines."
            else:
                verdict = "Below break-even — contact cost exceeds incremental recovery at this frequency."

            lines.append(f"  {verdict}")
            lines.append("")

    add_text_page(pp, f"{method_name} — {tier}", lines, institution)


# ---- Replace your broken block with this ----

def plot_method(method_name: str, pieces, pp, institution, client_totals=None, chart_color="#2E7D32", combo_order_override=None, prior_lookup: dict | None = None):
    _combo_order = combo_order_override if combo_order_override is not None else combo_order
    for tg, g in pieces:
        if g is None or g.empty:
            continue
        n_clients = int(client_totals.get(tg, 0)) if client_totals else 0

        is_combo = "Combo" in g.columns
        if is_combo:
            g = g.set_index("Combo").reindex(_combo_order).reset_index()
            # Ensure plain float64 so downstream float() / arithmetic never sees pd.NA
            for _fc in ["Profit_per_Record","Revenue_per_Record","Cost_per_Record",
                        "N_Records","N_Clients","Paying_Customers","Revenue_Sum",
                        "ROI_per_Record","RR_count","RR_value","RA_value"]:
                if _fc in g.columns:
                    g[_fc] = pd.to_numeric(g[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
            if g["N_Records"].fillna(0).sum() == 0:
                continue
            ymax_raw = float(g["Profit_per_Record"].fillna(0).max())
            ymin_raw = float(min(0.0, g["Profit_per_Record"].fillna(0).min() * 1.05))
            yrange = max(1.0, ymax_raw - ymin_raw)


            fig = plt.figure(figsize=(8.5, 8))
            gs = fig.add_gridspec(2, 1, height_ratios=[3, 1])
            ax_chart = fig.add_subplot(gs[0])
            ax_table = fig.add_subplot(gs[1])

            # Circle size proportional to N_Records (really big!)
            _nr_max = g["N_Records"].fillna(0).max()
            sizes = 400 + 1500 * (g["N_Records"].fillna(0) / (_nr_max if _nr_max > 0 else 1))

            # Single color
            color = chart_color

            # %-change vs prior period — label only, no prior-period bubble drawn.
            if prior_lookup:
                for combo_x, cur_y_raw in zip(g["Combo"], g["Profit_per_Record"]):
                    pd_val = prior_lookup.get((tg, combo_x))
                    if pd_val is None or np.isnan(pd_val[0]):
                        continue
                    prior_profit = pd_val[0]
                    cur_y = float(cur_y_raw) if not (cur_y_raw is None or (isinstance(cur_y_raw, float) and np.isnan(cur_y_raw))) else None
                    if cur_y is not None and prior_profit != 0:
                        delta_pct = (cur_y - prior_profit) / abs(prior_profit) * 100
                        delta_str = f"+{delta_pct:.0f}%" if delta_pct >= 0 else f"({abs(delta_pct):.0f}%)"
                        delta_clr = "#2E7D32" if delta_pct >= 0 else "#C62828"
                        ax_chart.annotate(
                            delta_str,
                            xy=(combo_x, cur_y), xytext=(0, 14), textcoords="offset points",
                            ha="center", va="bottom",
                            fontsize=7.5, color=delta_clr, fontweight="bold",
                        )

            # Scatter plot (current period, on top)
            ax_chart.scatter(
                g["Combo"],
                g["Profit_per_Record"],
                s=sizes,
                color=color,
                alpha=0.7,
                edgecolor=None,
                zorder=3
            )

            # Annotate points
            for x, y, row in zip(g["Combo"], g["Profit_per_Record"], g.itertuples(index=False)):
                ax_chart.text(
                    x,
                    y,
                    f"{fmt_money_short(row.Profit_per_Record)}",
                    ha="center",
                    va="bottom",
                    fontsize=8,
                    color="black",
                )

            ax_chart.set_title(f"{method_name} — {tg} (Average Profit per Record)")
            ax_chart.set_xlabel("Recovery Method")
            ax_chart.set_ylabel("Average Profit per Record (₦)")
            # --- Auto-adjust Y limits ---
            ax_chart.legend(frameon=False, loc="best")

            ax_chart.text(
                0.99,
                0.95,
                f"n = {n_clients:,} distinct clients",
                transform=ax_chart.transAxes,
                ha="right",
                va="top",
                fontsize=9,
                color="dimgray"
            )

            from matplotlib.ticker import MaxNLocator

            # --- Clean Auto Y-Scaling using Tick Locator ---
            y_vals = pd.to_numeric(g["Profit_per_Record"], errors="coerce").fillna(0.0)

            locator = MaxNLocator(nbins=6)
            ticks = locator.tick_values(y_vals.min(), y_vals.max())

            # Use first and last tick as y-axis limits
            ax_chart.set_ylim(ticks[0], ticks[-1])

            # Lock the axis so Matplotlib cannot override it
            ax_chart.set_autoscaley_on(False)
            ax_chart.autoscale(False)

            plt.xticks(rotation=15, ha="right")


            # Table part (reuse your table building code)
            ax_table.axis("off")
            columns = ["Combo", "   Avg. Profit", "Avg. Cost", "Avg. ROI", "Avg. Revenue", "Conv_Rate","Rec. Rate", "Avg. Recv.", "Records", "N Clients", "Paying Clients", "Total Revenue"]
            table_df = g[["Combo", "Profit_per_Record","Cost_per_Record", "ROI_per_Record","Revenue_per_Record", "RR_count","RR_value","RA_value", "N_Records", "N_Clients", "Paying_Customers","Revenue_Sum"]].copy()
            table_df["Profit_per_Record"] = table_df["Profit_per_Record"].apply(fmt_money_short)
            table_df["Cost_per_Record"]= table_df["Cost_per_Record"].apply(fmt_money_short)
            table_df["ROI_per_Record"] = table_df["ROI_per_Record"].apply(fmt_roi)
            table_df["Revenue_per_Record"] = table_df["Revenue_per_Record"].apply(fmt_money_short)
            table_df["RR_count"] = table_df["RR_count"].apply(fmt_pct)
            table_df = table_df.rename(columns={"RR_count": "Conv_Rate"})
            table_df["RR_value"] = table_df["RR_value"].apply(fmt_pct)
            table_df["RA_value"] = table_df["RA_value"].apply(fmt_money_short)
            table_df["N_Records"] = table_df["N_Records"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["N_Clients"] = table_df["N_Clients"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["Paying_Customers"] = table_df["Paying_Customers"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["Revenue_Sum"] = table_df["Revenue_Sum"].apply(fmt_money_short)
           
            table_df.columns = columns
            table_df = table_df.set_index("Combo").T
            table_df.index.name = None
            table_df.reset_index(inplace=True)
            table_df.rename(columns={"index": "Combo"}, inplace=True)
            table_df.index = ["" for _ in range(len(table_df))]

            table = ax_table.table(
                cellText=table_df.values.tolist(),
                rowLabels=table_df.index.tolist(),
                colLabels=table_df.columns.tolist(),
                loc="center",
                cellLoc="center",
                #colWidths=col_widths
            )
            table.auto_set_font_size(False)
            table.set_fontsize(8)
            for (i, j), cell in table.get_celld().items():
                cell.set_edgecolor("white")
                if i in (-1, 0):
                    cell.set_facecolor("#4CAF50")
                    cell.set_text_props(color="white", weight="bold")
                elif i % 2 == 0:
                    cell.set_facecolor("#E8F5E9")
                else:
                    cell.set_facecolor("#F1F8E9")
                    cell.set_edgecolor("white")

            add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME,institution)
            plt.subplots_adjust(bottom=0.08)
            pp.savefig(fig, bbox_inches="tight", pad_inches=0.3)
            plt.close(fig)
            add_chart_analysis(pp, method_name, tg, g,institution)

        else:
            # (Use your count-based plotting code)
            excluded_total = int(safe_num(g.loc[g["N_Records"] < MIN_N, "N_Records"].sum()))
            if institution == "GROOMING MFI" or institution == "All Institutions":
                g_plot = g[g["N_Records"] >= MIN_N].copy()
                # apply your usual threshold

            else:
                g_plot = g.copy()
                # keep all groups, no filtering

            if g_plot.empty:
                continue


            ymax_raw = float(g_plot["Profit_per_Record"].max())
            ymin_raw = float(min(0.0, g_plot["Profit_per_Record"].min() * 1.05))
            yrange = max(1.0, ymax_raw - ymin_raw)


            fig = plt.figure(figsize=(8.5, 8))
            gs = fig.add_gridspec(2, 1, height_ratios=[3, 1])
            ax_chart = fig.add_subplot(gs[0])
            ax_table = fig.add_subplot(gs[1])

            x = g_plot["Count"].astype(float)
            y = g_plot["Profit_per_Record"]
            size_scale = 400 + 1800 * (g_plot["N_Records"] / g_plot["N_Records"].max())

            ax_chart.set_xticks(sorted(g_plot["Count"].unique()))
            ax_chart.scatter(x, y, s=size_scale, c=chart_color, edgecolor=None, alpha=0.85, linewidth=1.5)
            ax_chart.grid(False)

            for xi, yi, val, size in zip(x, y, g_plot["Profit_per_Record"], size_scale):

                font_size = 8  # larger font for bigger bubbles
                ax_chart.text(
                    xi,
                    yi,
                    f"{fmt_money_short(val)}",
                    ha="center",
                    va="center",
                    fontsize=font_size,
                    color= "black",
                    weight=None,
                    alpha=0.9,
                )

            # %-change vs prior period — label only, no prior-period bubble drawn.
            # Keyed by (tier_group, Count) — same convention as the Combo charts.
            if prior_lookup:
                for count_x, cur_y_raw in zip(g_plot["Count"], g_plot["Profit_per_Record"]):
                    pd_val = prior_lookup.get((tg, count_x))
                    if pd_val is None or np.isnan(pd_val[0]):
                        continue
                    prior_profit = pd_val[0]
                    cur_y = float(cur_y_raw) if not (cur_y_raw is None or (isinstance(cur_y_raw, float) and np.isnan(cur_y_raw))) else None
                    if cur_y is not None and prior_profit != 0:
                        delta_pct = (cur_y - prior_profit) / abs(prior_profit) * 100
                        delta_str = f"+{delta_pct:.0f}%" if delta_pct >= 0 else f"({abs(delta_pct):.0f}%)"
                        delta_clr = "#2E7D32" if delta_pct >= 0 else "#C62828"
                        ax_chart.annotate(
                            delta_str,
                            xy=(count_x, cur_y), xytext=(0, 14), textcoords="offset points",
                            ha="center", va="bottom",
                            fontsize=7.5, color=delta_clr, fontweight="bold",
                        )

            # Trendline — skip if any NaN/inf or if all x values are identical
            if len(x) > 1:
                _mask = np.isfinite(x.astype(float)) & np.isfinite(pd.to_numeric(y, errors="coerce").to_numpy(dtype=float, na_value=np.nan))
                x_fit, y_fit = x.astype(float)[_mask], pd.to_numeric(y, errors="coerce").to_numpy(dtype=float, na_value=np.nan)[_mask]
                if len(x_fit) > 1 and x_fit.min() != x_fit.max():
                    try:
                        m, b = np.polyfit(x_fit, y_fit, 1)
                        x_line = np.linspace(x_fit.min(), x_fit.max(), 100)
                        y_line = m * x_line + b
                        ax_chart.plot(x_line, y_line, c="#EAD61C", linewidth=1.4, linestyle="-", alpha=0.9, label="Trendline")
                    except np.linalg.LinAlgError:
                        pass

            ax_chart.set_title(f"{method_name} — {tg} (Average Profit vs Count)")
            ax_chart.set_xlabel(f"{method_name}")
            ax_chart.set_ylabel("Average Profit(₦)")

            ax_chart.legend(frameon=False, loc="best")

            ax_chart.text(
                0.99,
                0.95,
                f"n = {n_clients:,} distinct customers",
                transform=ax_chart.transAxes,
                ha="right",
                va="top",
                fontsize=8,
                color="dimgray"
            )

            from matplotlib.ticker import MaxNLocator

            # --- Clean Auto Y-Scaling using Tick Locator ---
            # Ensure numeric values
            y_vals = pd.to_numeric(g_plot["Profit_per_Record"], errors="coerce").fillna(0.0)

            # Create a tick locator (6 bins = good visual spacing)
            locator = MaxNLocator(nbins=6)

            # Ask Matplotlib to generate nice tick positions for your actual data
            ticks = locator.tick_values(y_vals.min(), y_vals.max())

            # Use first and last tick as y-axis limits
            ax_chart.set_ylim(ticks[0], ticks[-1])

            # Lock the axis so Matplotlib cannot override it
            ax_chart.set_autoscaley_on(False)
            ax_chart.autoscale(False)

            ax_chart.grid(False)



            ax_table.axis("off")
            columns = ["Count", "Avg. Profit", "Avg. Cost", "Avg. ROI", "Avg. Revenue","Conv_Rate","Rec. Rate","Avg. Recv.", "Records", "N Clients", "Paying Clients", "Total Revenue"]
            table_df = g_plot[["Count", "Profit_per_Record","Cost_per_Record", "ROI_per_Record", "Revenue_per_Record", "RR_count","RR_value","RA_value", "N_Records", "N_Clients", "Paying_Customers", "Revenue_Sum"]].copy()
            table_df["Profit_per_Record"] = table_df["Profit_per_Record"].apply(fmt_money_short)
            table_df["Cost_per_Record"] = table_df["Cost_per_Record"].apply(fmt_money_short)
            table_df["ROI_per_Record"] = table_df["ROI_per_Record"].apply(fmt_roi)
            table_df["Revenue_per_Record"] = table_df["Revenue_per_Record"].apply(fmt_money_short)
            table_df["RR_count"] = table_df["RR_count"].apply(fmt_pct)
            table_df = table_df.rename(columns={"RR_count": "Conv_Rate"})
            table_df["RR_value"] = table_df["RR_value"].apply(fmt_pct)
            table_df["RA_value"] = table_df["RA_value"].apply(fmt_money_short)
            table_df["N_Records"] = table_df["N_Records"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["N_Clients"] = table_df["N_Clients"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["Paying_Customers"] = table_df["Paying_Customers"].fillna(0).apply(lambda x: f"{int(x):,}")
            table_df["Revenue_Sum"] = table_df["Revenue_Sum"].apply(fmt_money_short)
            table_df.columns = columns
            table_df = table_df.set_index("Count").T
            table_df.index.name = None
            table_df.reset_index(inplace=True)
            table_df.rename(columns={"index": "Count"}, inplace=True)
            table_df.index = ["" for _ in range(len(table_df))]

            table = ax_table.table(
                cellText=table_df.values.tolist(),
                rowLabels=table_df.index.tolist(),
                colLabels=table_df.columns.tolist(),
                loc="center",
                cellLoc="center",
                #colWidths=[0.15] * len(table_df.columns),
            )
            table.auto_set_font_size(False)
            table.set_fontsize(8)
            for (i, j), cell in table.get_celld().items():
                cell.set_edgecolor("white")
                if i in (-1, 0):
                    cell.set_facecolor("#4CAF50")
                    cell.set_text_props(color="white", weight="bold")
                elif i % 2 == 0:
                    cell.set_facecolor("#E8F5E9")
                else:
                    cell.set_facecolor("#F1F8E9")
                    cell.set_edgecolor("white")

            add_header(fig, COMPANY_LOGO_PATH, COMPANY_NAME, institution)
            plt.subplots_adjust(bottom=0.08)
            pp.savefig(fig, bbox_inches="tight", pad_inches=0.3)
            plt.close(fig)
            add_chart_analysis(pp, method_name, tg, g_plot,institution)


# ---- create a single PDF with one intro, then loop institutions ----
# compute overall coverage dates if date_col exists
if date_col and date_col in df.columns:
    dts_all = pd.to_datetime(df[date_col], errors="coerce")
    min_date_all = pd.to_datetime(dts_all.min()).date() if dts_all.notna().sum() > 0 else None
    max_date_all = pd.to_datetime(dts_all.max()).date() if dts_all.notna().sum() > 0 else None
else:
    min_date_all = max_date_all = None

with PdfPages(PDF_PATH) as pp:
    # Overview chart palette
    loan_type_color = "#2F6EA5"    # blue
    loan_amount_color = "#6A4C93"  # purple
    dpd_color = "#3F8A4D"          # green, close to original theme

    # add intro once
    add_intro_page(pp, Recovery_min, Recovery_max, Deposit_max)

    add_executive_summary_page(
        pp, df,
        dep_col=dep_col,
        sms_cost_col=sms_cost_col,
        vb_cost_col=vb_cost_col,
        out_cost_col=out_cost_col,
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        date_from=DATE_FROM,
        date_to=DATE_TO,
        deposit_to=DEPOSIT_TO,
        institutions=INSTITUTIONS,
    )

    add_contact_methods_comparison_page(
        pp, df, df_prior,
        date_from=DATE_FROM, date_to=DATE_TO,
        prior_date_from=PRIOR_DATE_FROM, prior_date_to=PRIOR_DATE_TO,
    )

    add_overview_page(pp)

    # ---- global loan-category summary (independent of institution) ----
    df_global = df.copy()
    df_global["sms_count"]          = pd.to_numeric(df_global[sms_col], errors="coerce").fillna(0).astype(int)
    df_global["vb_count"]           = pd.to_numeric(df_global[vb_col], errors="coerce").fillna(0).astype(int)
    df_global["out_count"]          = pd.to_numeric(df_global[out_col], errors="coerce").fillna(0).astype(int)
    df_global["cum_rec"]            = pd.to_numeric(df_global[cum_rec], errors="coerce").fillna(0).astype(int)
    df_global["va_bot_count"]        = _to_int_col(df_global, "total_va_bot")
    df_global["cum_va_bot"]          = _to_int_col(df_global, "cum_va_bot")
    df_global["cum_wa_bot"]          = _to_int_col(df_global, "cum_wa_bot")
    df_global["cum_email"]           = _to_int_col(df_global, "cum_email")
    df_global["cum_agent_wa"]        = _to_int_col(df_global, "cum_agent_wa")
    df_global["wa_bot_count"]        = _to_int_col(df_global, "total_wa_bot")
    df_global["email_count"]         = _to_int_col(df_global, "total_email")
    df_global["agent_contact_count"] = _to_int_col(df_global, "total_weekly_agent_contact")
    df_global["agent_wa_count"]      = _to_int_col(df_global, "total_agent_wa")
    df_global["agent_call_count"]    = _to_int_col(df_global, "total_agent_call")
    df_global["va_bot_cost"]  = pd.to_numeric(df_global["va_bot_call_duration_sec"], errors="coerce").fillna(0).clip(lower=0) * 2.5 if "va_bot_call_duration_sec" in df_global.columns else 0.0
    df_global["email_cost"]   = pd.to_numeric(df_global["total_email"], errors="coerce").fillna(0).clip(lower=0) * 1.0  if "total_email" in df_global.columns else 0.0
    df_global["wa_bot_cost"]  = 0.0
    df_global["Combo_v2"]    = df_global.apply(combo_label_row_v2, axis=1)
    df_global["Combo_v3"]    = df_global.apply(combo_label_row_v3, axis=1)
    df_global_sms_only    = filter_contact_segment(df_global, "sms_only")
    df_global_sms_vb_only = filter_contact_segment(df_global, "sms_vb_only")
    df_global_sms_vb_only["sms_vb_count"] = df_global_sms_vb_only[["sms_count", "vb_count"]].min(axis=1).astype(int)

    loan_category_pieces, chart_totals_loan, loan_categories, loan_category_client_totals = build_method_summary(
        df_global_sms_only,
        count_col="sms_count",
        deposit_col=dep_col,
        cost_col=sms_cost_col,      # must exist globally
        unit_cost_fallback=COST_SMS_FALLBACK,
        tier_col="loan_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    loan_category_pieces_sms_vb, _, _, loan_category_sms_vb_client_totals = build_method_summary(
        df_global_sms_vb_only,
        count_col="sms_vb_count",
        deposit_col=dep_col,
        cost_col="total_cost",
        unit_cost_fallback=COST_SMS_FALLBACK + COST_VB_FALLBACK,
        tier_col="loan_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    loan_category_pieces_vb, chart_totals_loan_vb, loan_categories_vb, loan_category_vb_client_totals = build_method_summary(
        df_global,
        count_col="vb_count",
        deposit_col=dep_col,
        cost_col=vb_cost_col,      # must exist globally
        unit_cost_fallback=COST_VB_FALLBACK,
        tier_col="loan_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

        #Loan amount
    loan_amount_pieces, chart_totals_loan_amount, loan_amount_categories, loan_amount_client_totals = build_method_summary(
        df_global_sms_only,
        count_col="sms_count",
        deposit_col=dep_col,
        cost_col=sms_cost_col,      # must exist globally
        unit_cost_fallback=COST_SMS_FALLBACK,
        tier_col="amount_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    loan_amount_pieces_sms_vb, _, _, loan_amount_sms_vb_client_totals = build_method_summary(
        df_global_sms_vb_only,
        count_col="sms_vb_count",
        deposit_col=dep_col,
        cost_col="total_cost",
        unit_cost_fallback=COST_SMS_FALLBACK + COST_VB_FALLBACK,
        tier_col="amount_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    loan_amount_pieces_vb, chart_totals_loan_amount_vb, loan_amount_categories_vb, loan_amount_vb_client_totals = build_method_summary(
        df_global,
        count_col="vb_count",
        deposit_col=dep_col,
        cost_col=vb_cost_col,      # must exist globally
        unit_cost_fallback=COST_VB_FALLBACK,
        tier_col="amount_category",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

        #dpd
    dpd_pieces, dpd_chart_totals, dpd_loan_amount_categories, dpd_client_totals = build_method_summary(
        df_global_sms_only,
        count_col="sms_count",
        deposit_col=dep_col,
        cost_col=sms_cost_col,      # must exist globally
        unit_cost_fallback=COST_SMS_FALLBACK,
        tier_col="dpd",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    dpd_pieces_sms_vb, _, _, dpd_sms_vb_client_totals = build_method_summary(
        df_global_sms_vb_only,
        count_col="sms_vb_count",
        deposit_col=dep_col,
        cost_col="total_cost",
        unit_cost_fallback=COST_SMS_FALLBACK + COST_VB_FALLBACK,
        tier_col="dpd",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )

    dpd_pieces_vb, dpd_chart_totals_vb, dpd_loan_amount_categories_vb, dpd_vb_client_totals = build_method_summary(
        df_global,
        count_col="vb_count",
        deposit_col=dep_col,
        cost_col=vb_cost_col,      # must exist globally
        unit_cost_fallback=COST_VB_FALLBACK,
        tier_col="dpd",
        tvol_col=tvol_col,
        final_bal_col=final_bal_col,
        cum_rec="cum_rec"
        )
    def build_combo_summary_global(df, group_col):
        df = df.copy()
        client_totals = {}

        if "Combo" not in df.columns:
            df["Combo"] = df.apply(combo_label_row, axis=1)

        df["sms_count"] = pd.to_numeric(df[sms_col], errors="coerce").fillna(0).astype(int)
        df["vb_count"]  = pd.to_numeric(df[vb_col], errors="coerce").fillna(0).astype(int)
        df["vb_cost"]   = pd.to_numeric(df[vb_cost_col], errors="coerce").fillna(0).astype(int)
        df["sms_cost"]  = pd.to_numeric(df[sms_cost_col], errors="coerce").fillna(0).astype(int)
        df["__tvol"] = pd.to_numeric(df[tvol_col], errors="coerce") if (tvol_col and tvol_col in df.columns) else np.nan
        df["__fb"]   = pd.to_numeric(df[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in df.columns) else np.nan

        # matched costs
        vb_unit = df["vb_cost"] / df["vb_count"].replace(0, 1)
        df["matched_vb_count"] = df[["sms_count", "vb_count"]].min(axis=1)
        df["matched_vb_cost"]  = vb_unit * df["matched_vb_count"]

        # Agent Contact = agent cost only; other buckets = their channel costs
        _agent_cost_g = (
            pd.to_numeric(df[out_cost_col], errors="coerce").fillna(0).clip(lower=0)
            if out_cost_col and out_cost_col in df.columns else 0.0
        )
        df["total_cost"] = np.select(
            [df["Combo"] == "Agent Contact"],
            [_agent_cost_g],
            default=df["sms_cost"] + df["matched_vb_cost"]
        )

        # first do normal aggregation
        grouped = (
            df.groupby([group_col, "Combo"])
            .agg(
                Revenue_per_Record=(dep_col, "mean"),
                Cost_per_Record=("total_cost", "mean"),
                N_Records=("Combo", "size"),
                Paying_Customers=("__payer", "sum"),
                Revenue_Sum=(dep_col, "sum"),
                Cost_Sum=("total_cost", "sum"),
                Avg_TVOL=("__tvol", "mean"),
                FinalBalance_Sum=("__fb", "sum"),
            )
            .reset_index()
        )

        # now compute derived metric
        grouped["N_Records"] = grouped["N_Records"].fillna(0)
        grouped["Paying_Customers"] = grouped["Paying_Customers"].fillna(0)
        # N_Clients == N_Records since one row per client
        grouped["N_Clients"] = grouped["N_Records"]
        grouped["Profit_per_Record"] = grouped["Revenue_per_Record"] - grouped["Cost_per_Record"]
        grouped["ROI_per_Record"] = np.where(grouped["Cost_per_Record"] > 0, grouped["Profit_per_Record"] / grouped["Cost_per_Record"], np.nan)
        grouped["Profit_Total"] = grouped["Revenue_Sum"] - grouped["Cost_Sum"]
        grouped["Profit_per_Payer"] = np.where(grouped["Paying_Customers"] > 0, grouped["Profit_Total"] / grouped["Paying_Customers"], np.nan)
        grouped["RR_count"] = np.where(grouped["N_Records"] > 0, grouped["Paying_Customers"] / grouped["N_Records"], np.nan)
        grouped["RR_value"] = np.where(grouped["FinalBalance_Sum"] > 0, grouped["Revenue_Sum"] / grouped["FinalBalance_Sum"], np.nan)
        grouped["RA_value"] = np.where(grouped["Paying_Customers"] > 0, grouped["Revenue_Sum"]/ grouped["Paying_Customers"],np.nan)

        # convert grouped results into list of (group_value, dataframe)
        # enforce the same combo order used in institution-level charts
        pieces = []
        for key, sub in grouped.groupby(group_col):
            sub_ordered = sub.set_index("Combo").reindex(combo_order).reset_index()
            sub_ordered[group_col] = key
            pieces.append((key, sub_ordered))
        for key, raw_sub in df.groupby(group_col):
            # N_Records == N_Clients by construction
            client_totals[key] = int(raw_sub.shape[0])
        if group_col == "amount_category":
            pieces = sorted(pieces, key=lambda x: amount_sort_key(x[0]))
# ---------------------------------------------

        return pieces, client_totals

    combo_by_loan_category, combo_by_loan_category_client_totals = build_combo_summary_global(df_global, "loan_category")
    combo_by_loan_amount, combo_by_loan_amount_client_totals = build_combo_summary_global(df_global, "amount_category")
    combo_by_dpd, combo_by_dpd_client_totals = build_combo_summary_global(df_global, "dpd")

    def build_combo_summary_global_v2(df, group_col):
        df = df.copy()
        if "Combo_v2" not in df.columns:
            df["Combo_v2"] = df.apply(combo_label_row_v2, axis=1)
        # v2 cost: WA bot + email only for active buckets; None/Never get sms+vb+agent_call
        df["__cost"] = df["wa_bot_cost"] + df["email_cost"]
        _none_gv2  = df["Combo_v2"].isin(["None", "Never"])
        _sms_c_gv2 = pd.to_numeric(df[sms_cost_col], errors="coerce").fillna(0).clip(lower=0) if sms_cost_col and sms_cost_col in df.columns else pd.Series(0.0, index=df.index)
        _vb_c_gv2  = pd.to_numeric(df[vb_cost_col],  errors="coerce").fillna(0).clip(lower=0) if vb_cost_col  and vb_cost_col  in df.columns else pd.Series(0.0, index=df.index)
        _out_c_gv2 = pd.to_numeric(df[out_cost_col], errors="coerce").fillna(0).clip(lower=0) if out_cost_col and out_cost_col in df.columns else pd.Series(0.0, index=df.index)
        df.loc[_none_gv2, "__cost"] = _sms_c_gv2[_none_gv2] + _vb_c_gv2[_none_gv2] + _out_c_gv2[_none_gv2]
        df["__tvol"] = pd.to_numeric(df[tvol_col], errors="coerce") if (tvol_col and tvol_col in df.columns) else np.nan
        df["__fb"]   = pd.to_numeric(df[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in df.columns) else np.nan
        grouped = (
            df.groupby([group_col, "Combo_v2"])
            .agg(Revenue_per_Record=(dep_col, "mean"),
                 Cost_per_Record=("__cost", "mean"),
                 N_Records=("Combo_v2", "size"),
                 Paying_Customers=("__payer", "sum"),
                 Revenue_Sum=(dep_col, "sum"),
                 Cost_Sum=("__cost", "sum"),
                 Avg_TVOL=("__tvol", "mean"),
                 FinalBalance_Sum=("__fb", "sum"))
            .reset_index()
        )
        grouped["N_Records"] = grouped["N_Records"].fillna(0)
        grouped["Paying_Customers"] = grouped["Paying_Customers"].fillna(0)
        grouped["N_Clients"] = grouped["N_Records"]
        grouped["Profit_per_Record"] = grouped["Revenue_per_Record"] - grouped["Cost_per_Record"]
        grouped["ROI_per_Record"] = np.where(grouped["Cost_per_Record"] > 0, grouped["Profit_per_Record"] / grouped["Cost_per_Record"], np.nan)
        grouped["Profit_Total"] = grouped["Revenue_Sum"] - grouped["Cost_Sum"]
        grouped["Profit_per_Payer"] = np.where(grouped["Paying_Customers"] > 0, grouped["Profit_Total"] / grouped["Paying_Customers"], np.nan)
        grouped["RR_count"] = np.where(grouped["N_Records"] > 0, grouped["Paying_Customers"] / grouped["N_Records"], np.nan)
        grouped["RR_value"] = np.where(grouped["FinalBalance_Sum"] > 0, grouped["Revenue_Sum"] / grouped["FinalBalance_Sum"], np.nan)
        grouped["RA_value"] = np.where(grouped["Paying_Customers"] > 0, grouped["Revenue_Sum"] / grouped["Paying_Customers"], np.nan)
        grouped = grouped.rename(columns={"Combo_v2": "Combo"})
        client_totals = {}
        pieces = []
        for key, sub in grouped.groupby(group_col):
            client_totals[key] = int(df[df[group_col] == key].shape[0])
            pieces.append((key, sub))
        if group_col == "amount_category":
            pieces = sorted(pieces, key=lambda x: amount_sort_key(x[0]))
        return pieces, client_totals

    combo_v2_by_loan_category, combo_v2_by_loan_category_ct = build_combo_summary_global_v2(df_global, "loan_category")
    combo_v2_by_loan_amount, combo_v2_by_loan_amount_ct     = build_combo_summary_global_v2(df_global, "amount_category")
    combo_v2_by_dpd, combo_v2_by_dpd_ct                     = build_combo_summary_global_v2(df_global, "dpd")

    def build_combo_summary_global_v3(df, group_col):
        df = df.copy()
        client_totals = {}
        if "Combo_v3" not in df.columns:
            df["Combo_v3"] = df.apply(combo_label_row_v3, axis=1)
        _out_cost = pd.to_numeric(df[out_cost_col], errors="coerce").fillna(0).clip(lower=0) if out_cost_col and out_cost_col in df.columns else 0.0
        df["__cost"] = df["va_bot_cost"] + _out_cost
        _none_gv3 = df["Combo_v3"] == "None"
        _sms_c_gv3 = pd.to_numeric(df[sms_cost_col], errors="coerce").fillna(0).clip(lower=0) if sms_cost_col and sms_cost_col in df.columns else pd.Series(0.0, index=df.index)
        _vb_c_gv3  = pd.to_numeric(df[vb_cost_col],  errors="coerce").fillna(0).clip(lower=0) if vb_cost_col  and vb_cost_col  in df.columns else pd.Series(0.0, index=df.index)
        df.loc[_none_gv3, "__cost"] = df.loc[_none_gv3, "wa_bot_cost"] + df.loc[_none_gv3, "email_cost"] + _sms_c_gv3[_none_gv3] + _vb_c_gv3[_none_gv3]
        df["__tvol"] = pd.to_numeric(df[tvol_col], errors="coerce") if (tvol_col and tvol_col in df.columns) else np.nan
        df["__fb"]   = pd.to_numeric(df[final_bal_col], errors="coerce") if (final_bal_col and final_bal_col in df.columns) else np.nan

        grouped = (
            df.groupby([group_col, "Combo_v3"])
            .agg(
                Revenue_per_Record=(dep_col, "mean"),
                Cost_per_Record=("__cost", "mean"),
                N_Records=("Combo_v3", "size"),
                Paying_Customers=("__payer", "sum"),
                Revenue_Sum=(dep_col, "sum"),
                Cost_Sum=("__cost", "sum"),
                Avg_TVOL=("__tvol", "mean"),
                FinalBalance_Sum=("__fb", "sum"),
            )
            .reset_index()
        )
        for _c in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                   "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
            grouped[_c] = pd.to_numeric(grouped[_c], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        grouped["N_Records"]        = grouped["N_Records"].fillna(0)
        grouped["Paying_Customers"] = grouped["Paying_Customers"].fillna(0)
        grouped["N_Clients"]        = grouped["N_Records"]
        grouped["Profit_per_Record"] = grouped["Revenue_per_Record"] - grouped["Cost_per_Record"]
        grouped["ROI_per_Record"]    = np.where(grouped["Cost_per_Record"] > 0, grouped["Profit_per_Record"] / grouped["Cost_per_Record"], np.nan)
        grouped["Profit_Total"]      = grouped["Revenue_Sum"] - grouped["Cost_Sum"]
        grouped["Profit_per_Payer"]  = np.where(grouped["Paying_Customers"] > 0, grouped["Profit_Total"] / grouped["Paying_Customers"], np.nan)
        grouped["RR_count"] = np.where(grouped["N_Records"] > 0, grouped["Paying_Customers"] / grouped["N_Records"], np.nan)
        grouped["RR_value"] = np.where(grouped["FinalBalance_Sum"] > 0, grouped["Revenue_Sum"] / grouped["FinalBalance_Sum"], np.nan)
        grouped["RA_value"] = np.where(grouped["Paying_Customers"] > 0, grouped["Revenue_Sum"] / grouped["Paying_Customers"], np.nan)

        pieces = []
        for key, sub in grouped.groupby(group_col):
            sub_ordered = (
                sub.set_index("Combo_v3")
                .reindex(combo_order_v3)
                .reset_index()
                .rename(columns={"Combo_v3": "Combo"})
            )
            sub_ordered[group_col] = key
            pieces.append((key, sub_ordered))
        for key, raw_sub in df.groupby(group_col):
            client_totals[key] = int(raw_sub.shape[0])
        if group_col == "amount_category":
            pieces = sorted(pieces, key=lambda x: amount_sort_key(x[0]))
        return pieces, client_totals

    combo_v3_by_loan_category, combo_v3_by_loan_category_ct = build_combo_summary_global_v3(df_global, "loan_category")
    combo_v3_by_loan_amount,   combo_v3_by_loan_amount_ct   = build_combo_summary_global_v3(df_global, "amount_category")
    combo_v3_by_dpd,           combo_v3_by_dpd_ct           = build_combo_summary_global_v3(df_global, "dpd")

    va_bot_loan_cat_pieces, _, _, va_bot_loan_cat_ct = build_method_summary(
        df_global, "va_bot_count", dep_col, "va_bot_cost", 0.0, "loan_category", tvol_col, final_bal_col, cum_rec
    )
    va_bot_loan_amt_pieces, _, _, va_bot_loan_amt_ct = build_method_summary(
        df_global, "va_bot_count", dep_col, "va_bot_cost", 0.0, "amount_category", tvol_col, final_bal_col, cum_rec
    )
    va_bot_dpd_pieces, _, _, va_bot_dpd_ct = build_method_summary(
        df_global, "va_bot_count", dep_col, "va_bot_cost", 0.0, "dpd", tvol_col, final_bal_col, cum_rec
    )

    # loop per institution and append pages to same PDF
    for inst_name, inst_df in df_week.groupby("institution", sort=False):
        inst_df = inst_df.copy()  # avoid SettingWithCopyWarning
        add_institution_intro_page(pp, inst_name)
        ##institution_line = [f"{inst_name}"]
        ##add_text_page(pp, "Institution:", institution_line)
        # print/log
        logger.info("Building report for institution: %s (n=%d)", inst_name, len(inst_df))

        # resolve columns for this institution slice
        try:
            mode_i, sms_col_i, vb_col_i, out_col_i, dep_col_i, date_col_i,cum_rec_i, tvol_col_i, final_bal_col_i, sms_cost_col_i, vb_cost_col_i,out_cost_col_i, _ = resolve_mode_and_columns(inst_df, FORCE_MODE)
        except Exception as e:
            logger.error("Skipping institution %s due to missing columns: %s", inst_name, e)
            continue

        # coerce numerics for this inst_df (safe checks)
        for c in (sms_col_i, vb_col_i,out_col_i, cum_rec_i,dep_col_i, tvol_col_i, final_bal_col_i, sms_cost_col_i, vb_cost_col_i,out_cost_col_i):
            if c and c in inst_df.columns:
                inst_df[c] = to_numeric_fill0(inst_df[c])

        # mapping and helper columns
        inst_df["tier_group"] = inst_df["client_bucket"]
        inst_df["sms_count"] = np.rint(inst_df[sms_col_i]).astype(int)
        inst_df["vb_count"] = np.rint(inst_df[vb_col_i]).astype(int)
        inst_df["out_count"] = np.rint(inst_df[out_col_i]).astype(int)
        inst_df["cum_rec"] = np.rint(inst_df[cum_rec_i]).astype(int)
        inst_df["__payer"] = (inst_df[dep_col_i] > 0).astype(int)
        inst_df["va_bot_count"]        = _to_int_col(inst_df, "total_va_bot")
        inst_df["cum_va_bot"]          = _to_int_col(inst_df, "cum_va_bot")
        inst_df["cum_wa_bot"]          = _to_int_col(inst_df, "cum_wa_bot")
        inst_df["cum_email"]           = _to_int_col(inst_df, "cum_email")
        inst_df["cum_agent_wa"]        = _to_int_col(inst_df, "cum_agent_wa")
        inst_df["wa_bot_count"]        = _to_int_col(inst_df, "total_wa_bot")
        inst_df["email_count"]         = _to_int_col(inst_df, "total_email")
        inst_df["agent_contact_count"] = _to_int_col(inst_df, "total_weekly_agent_contact")
        inst_df["agent_wa_count"]      = _to_int_col(inst_df, "total_agent_wa")
        inst_df["agent_call_count"]    = _to_int_col(inst_df, "total_agent_call")
        inst_df["va_bot_cost"]  = pd.to_numeric(inst_df["va_bot_call_duration_sec"], errors="coerce").fillna(0).clip(lower=0) * 2.5 if "va_bot_call_duration_sec" in inst_df.columns else 0.0
        inst_df["email_cost"]   = pd.to_numeric(inst_df["total_email"], errors="coerce").fillna(0).clip(lower=0) * 1.0  if "total_email" in inst_df.columns else 0.0
        inst_df["wa_bot_cost"]  = 0.0
        inst_df["Combo_v2"]    = inst_df.apply(combo_label_row_v2, axis=1)
        inst_df["Combo_v3"]    = inst_df.apply(combo_label_row_v3, axis=1)

        # build method summaries for this institution
        # Ensure numeric
        inst_df[sms_cost_col_i] = pd.to_numeric(inst_df[sms_cost_col_i], errors="coerce").fillna(0.0).clip(lower=0)
        inst_df[vb_cost_col_i]  = pd.to_numeric(inst_df[vb_cost_col_i],  errors="coerce").fillna(0.0).clip(lower=0)
        inst_df[out_cost_col_i]  = pd.to_numeric(inst_df[out_cost_col_i],  errors="coerce").fillna(0.0).clip(lower=0)

        # Matched VB cost = take min(sms_count, vb_count)
        inst_df["matched_vb_count"] = inst_df[["sms_count", "vb_count"]].min(axis=1)

        # Compute per-unit VB cost
        vb_unit_cost = inst_df[vb_cost_col_i] / inst_df["vb_count"].replace(0, 1)  # avoid div by 0

        # Matched VB cost = per-unit VB * matched VB count
        inst_df["matched_vb_cost"] = vb_unit_cost * inst_df["matched_vb_count"]
        inst_df["total_cost"] = inst_df[sms_cost_col_i] + inst_df["matched_vb_cost"]

        # Force 0 cost if no SMS and no VB
        inst_df.loc[(inst_df["sms_count"] == 0) & (inst_df["vb_count"] == 0), "total_cost"] = 0.0

        inst_sms_only    = filter_contact_segment(inst_df, "sms_only")
        inst_sms_vb_only = filter_contact_segment(inst_df, "sms_vb_only")
        inst_sms_vb_only["sms_vb_count"] = inst_sms_vb_only[["sms_count", "vb_count"]].min(axis=1).astype(int)

        sms_pieces_i, chart_totals_sms_i, tiers_i, sms_client_totals_i = build_method_summary(
            inst_sms_only, "sms_count", dep_col_i, sms_cost_col_i, COST_SMS_FALLBACK, "tier_group", tvol_col_i, final_bal_col_i, "cum_rec"
        )

        sms_vb_pieces_i, _, _, sms_vb_client_totals_i = build_method_summary(
            inst_sms_vb_only, "sms_vb_count", dep_col_i, "total_cost", COST_SMS_FALLBACK + COST_VB_FALLBACK, "tier_group", tvol_col_i, final_bal_col_i, "cum_rec"
        )

        vb_pieces_i, chart_totals_vb_i, _, vb_client_totals_i = build_method_summary(
            inst_df, "vb_count", dep_col_i, vb_cost_col_i, COST_VB_FALLBACK, "tier_group", tvol_col_i, final_bal_col_i, "cum_rec"
        )

        # build combo summaries per tier
        combo_summaries_i = {}
        combo_client_totals_i = {}
        for tg in tiers_i:
            sub = inst_df[inst_df["tier_group"] == tg].copy()
            # N_Records == N_Clients by construction
            combo_client_totals_i[tg] = int(sub.shape[0])
            if "Combo" not in sub.columns:
                sub["Combo"] = sub.apply(combo_label_row, axis=1)
            # compute per-record cost
            sms_cost_series = (
                np.where(
                    sub["sms_count"] > 0,
                    pd.to_numeric(sub[sms_cost_col_i], errors="coerce").fillna(0.0).clip(lower=0),
                    0.0
                )
                if sms_cost_col_i and sms_cost_col_i in sub.columns
                else sub["sms_count"].clip(lower=0) * COST_SMS_FALLBACK
            )

            vb_cost_series = (
                np.where(
                    sub["vb_count"] > 0,
                    pd.to_numeric(sub[vb_cost_col_i], errors="coerce").fillna(0.0).clip(lower=0),
                    0.0
                )
                if vb_cost_col_i and vb_cost_col_i in sub.columns
                else sub["vb_count"].clip(lower=0) * COST_VB_FALLBACK
            )
            out_cost_series = (
                np.where(
                    sub["out_count"] > 0,
                    pd.to_numeric(sub[out_cost_col_i], errors="coerce").fillna(0.0).clip(lower=0),
                    0.0
                )
                 if out_cost_col_i and out_cost_col_i in sub.columns
                else sub["out_count"].clip(lower=0) * COST_SMS_FALLBACK
            )

            # Each bucket's cost = only the channels in its label
            sub["__cost"] = np.select(
                [sub["Combo"] == "Agent Contact",
                 sub["Combo"] == "SMS + VB",
                 sub["Combo"] == "SMS only",
                 sub["Combo"] == "VB only"],
                [out_cost_series,
                 sms_cost_series + vb_cost_series,
                 sms_cost_series,
                 vb_cost_series],
                default=0.0
            )
            sub["__tvol"] = pd.to_numeric(sub[tvol_col_i], errors="coerce") if (tvol_col_i and tvol_col_i in sub.columns) else np.nan
            sub["__fb"] = pd.to_numeric(sub[final_bal_col_i], errors="coerce") if (final_bal_col_i and final_bal_col_i in sub.columns) else np.nan

            g_combo = (
                sub.groupby("Combo")
                .agg(
                    Revenue_per_Record=(dep_col_i, "mean"),
                    Cost_per_Record=("__cost", "mean"),
                    N_Records=("Combo", "size"),
                    Paying_Customers=("__payer", "sum"),
                    Revenue_Sum=(dep_col_i, "sum"),
                    Cost_Sum=("__cost", "sum"),
                    Avg_TVOL=("__tvol", "mean"),
                    FinalBalance_Sum=("__fb", "sum"),
                )
                .reindex(combo_order)
                .reset_index()
            )
            # Force plain float64 so np.where comparisons never see pd.NA after reindex
            for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                        "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
                if _fc in g_combo.columns:
                    g_combo[_fc] = pd.to_numeric(g_combo[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
            g_combo["N_Records"] = g_combo["N_Records"].fillna(0)
            g_combo["Paying_Customers"] = g_combo["Paying_Customers"].fillna(0)
            # N_Clients == N_Records since one row per client
            g_combo["N_Clients"] = g_combo["N_Records"]
            g_combo["Profit_per_Record"] = g_combo["Revenue_per_Record"] - g_combo["Cost_per_Record"]
            g_combo["ROI_per_Record"] = np.where(g_combo["Cost_per_Record"] > 0, g_combo["Profit_per_Record"] / g_combo["Cost_per_Record"], np.nan)
            g_combo["Profit_Total"] = g_combo["Revenue_Sum"] - g_combo["Cost_Sum"]
            g_combo["Profit_per_Payer"] = np.where(g_combo["Paying_Customers"] > 0, g_combo["Profit_Total"] / g_combo["Paying_Customers"], np.nan)
            g_combo["RR_count"] = np.where(g_combo["N_Records"] > 0, g_combo["Paying_Customers"] / g_combo["N_Records"], np.nan)
            g_combo["RR_value"] = np.where(g_combo["FinalBalance_Sum"] > 0, g_combo["Revenue_Sum"] / g_combo["FinalBalance_Sum"], np.nan)
            g_combo["RA_value"] = np.where(g_combo["Paying_Customers"] > 0, g_combo["Revenue_Sum"]/ g_combo["Paying_Customers"],np.nan)

            combo_summaries_i[tg] = g_combo

        # ── Per-institution v2 (Bot + Email) combo ──
        combo_summaries_v2_i, combo_v2_client_totals_i = {}, {}
        for tg in tiers_i:
            sub = inst_df[inst_df["tier_group"] == tg].copy()
            combo_v2_client_totals_i[tg] = int(sub.shape[0])
            sub["__cost"] = sub["wa_bot_cost"] + sub["email_cost"]
            _none_iv2  = sub["Combo_v2"].isin(["None", "Never"])
            _sms_c_iv2 = pd.to_numeric(sub[sms_cost_col_i],  errors="coerce").fillna(0).clip(lower=0) if sms_cost_col_i  and sms_cost_col_i  in sub.columns else pd.Series(0.0, index=sub.index)
            _vb_c_iv2  = pd.to_numeric(sub[vb_cost_col_i],   errors="coerce").fillna(0).clip(lower=0) if vb_cost_col_i   and vb_cost_col_i   in sub.columns else pd.Series(0.0, index=sub.index)
            _out_c_iv2 = pd.to_numeric(sub[out_cost_col_i],  errors="coerce").fillna(0).clip(lower=0) if out_cost_col_i  and out_cost_col_i  in sub.columns else pd.Series(0.0, index=sub.index)
            sub.loc[_none_iv2, "__cost"] = _sms_c_iv2[_none_iv2] + _vb_c_iv2[_none_iv2] + _out_c_iv2[_none_iv2]
            sub["__tvol"] = pd.to_numeric(sub[tvol_col_i], errors="coerce") if (tvol_col_i and tvol_col_i in sub.columns) else np.nan
            sub["__fb"]   = pd.to_numeric(sub[final_bal_col_i], errors="coerce") if (final_bal_col_i and final_bal_col_i in sub.columns) else np.nan
            g_v2 = (sub.groupby("Combo_v2")
                      .agg(Revenue_per_Record=(dep_col_i, "mean"),
                           Cost_per_Record=("__cost", "mean"),
                           N_Records=("Combo_v2", "size"),
                           Paying_Customers=("__payer", "sum"),
                           Revenue_Sum=(dep_col_i, "sum"),
                           Cost_Sum=("__cost", "sum"),
                           Avg_TVOL=("__tvol", "mean"),
                           FinalBalance_Sum=("__fb", "sum"))
                      .reindex(combo_order_v2)
                      .reset_index()
                      .rename(columns={"Combo_v2": "Combo"}))
            for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                        "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
                if _fc in g_v2.columns:
                    g_v2[_fc] = pd.to_numeric(g_v2[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
            g_v2["N_Records"] = g_v2["N_Records"].fillna(0)
            g_v2["Paying_Customers"] = g_v2["Paying_Customers"].fillna(0)
            g_v2["N_Clients"] = g_v2["N_Records"]
            g_v2["Profit_per_Record"] = g_v2["Revenue_per_Record"] - g_v2["Cost_per_Record"]
            g_v2["ROI_per_Record"]    = np.where(g_v2["Cost_per_Record"] > 0, g_v2["Profit_per_Record"] / g_v2["Cost_per_Record"], np.nan)
            g_v2["Profit_Total"]      = g_v2["Revenue_Sum"] - g_v2["Cost_Sum"]
            g_v2["Profit_per_Payer"]  = np.where(g_v2["Paying_Customers"] > 0, g_v2["Profit_Total"] / g_v2["Paying_Customers"], np.nan)
            g_v2["RR_count"] = np.where(g_v2["N_Records"] > 0, g_v2["Paying_Customers"] / g_v2["N_Records"], np.nan)
            g_v2["RR_value"] = np.where(g_v2["FinalBalance_Sum"] > 0, g_v2["Revenue_Sum"] / g_v2["FinalBalance_Sum"], np.nan)
            g_v2["RA_value"] = np.where(g_v2["Paying_Customers"] > 0, g_v2["Revenue_Sum"] / g_v2["Paying_Customers"], np.nan)
            combo_summaries_v2_i[tg] = g_v2

        # ── Per-institution v3 (VA Bot + Agent) combo ──
        combo_summaries_v3_i, combo_v3_client_totals_i = {}, {}
        for tg in tiers_i:
            sub = inst_df[inst_df["tier_group"] == tg].copy()
            combo_v3_client_totals_i[tg] = int(sub.shape[0])
            agent_cost_i = pd.to_numeric(sub[out_cost_col_i], errors="coerce").fillna(0).clip(lower=0) if out_cost_col_i and out_cost_col_i in sub.columns else 0.0
            sub["__cost"] = sub["va_bot_cost"] + agent_cost_i
            _none_iv3 = sub["Combo_v3"] == "None"
            _sms_c_iv3 = pd.to_numeric(sub[sms_cost_col_i], errors="coerce").fillna(0).clip(lower=0) if sms_cost_col_i and sms_cost_col_i in sub.columns else pd.Series(0.0, index=sub.index)
            _vb_c_iv3  = pd.to_numeric(sub[vb_cost_col_i],  errors="coerce").fillna(0).clip(lower=0) if vb_cost_col_i  and vb_cost_col_i  in sub.columns else pd.Series(0.0, index=sub.index)
            sub.loc[_none_iv3, "__cost"] = sub.loc[_none_iv3, "wa_bot_cost"] + sub.loc[_none_iv3, "email_cost"] + _sms_c_iv3[_none_iv3] + _vb_c_iv3[_none_iv3]
            sub["__tvol"] = pd.to_numeric(sub[tvol_col_i], errors="coerce") if (tvol_col_i and tvol_col_i in sub.columns) else np.nan
            sub["__fb"]   = pd.to_numeric(sub[final_bal_col_i], errors="coerce") if (final_bal_col_i and final_bal_col_i in sub.columns) else np.nan
            g_v3 = (sub.groupby("Combo_v3")
                      .agg(Revenue_per_Record=(dep_col_i, "mean"),
                           Cost_per_Record=("__cost", "mean"),
                           N_Records=("Combo_v3", "size"),
                           Paying_Customers=("__payer", "sum"),
                           Revenue_Sum=(dep_col_i, "sum"),
                           Cost_Sum=("__cost", "sum"),
                           Avg_TVOL=("__tvol", "mean"),
                           FinalBalance_Sum=("__fb", "sum"))
                      .reindex(combo_order_v3)
                      .reset_index()
                      .rename(columns={"Combo_v3": "Combo"}))
            for _fc in ["Revenue_per_Record","Cost_per_Record","N_Records","Paying_Customers",
                        "Revenue_Sum","Cost_Sum","FinalBalance_Sum"]:
                if _fc in g_v3.columns:
                    g_v3[_fc] = pd.to_numeric(g_v3[_fc], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
            g_v3["N_Records"] = g_v3["N_Records"].fillna(0)
            g_v3["Paying_Customers"] = g_v3["Paying_Customers"].fillna(0)
            g_v3["N_Clients"] = g_v3["N_Records"]
            g_v3["Profit_per_Record"] = g_v3["Revenue_per_Record"] - g_v3["Cost_per_Record"]
            g_v3["ROI_per_Record"]    = np.where(g_v3["Cost_per_Record"] > 0, g_v3["Profit_per_Record"] / g_v3["Cost_per_Record"], np.nan)
            g_v3["Profit_Total"]      = g_v3["Revenue_Sum"] - g_v3["Cost_Sum"]
            g_v3["Profit_per_Payer"]  = np.where(g_v3["Paying_Customers"] > 0, g_v3["Profit_Total"] / g_v3["Paying_Customers"], np.nan)
            g_v3["RR_count"] = np.where(g_v3["N_Records"] > 0, g_v3["Paying_Customers"] / g_v3["N_Records"], np.nan)
            g_v3["RR_value"] = np.where(g_v3["FinalBalance_Sum"] > 0, g_v3["Revenue_Sum"] / g_v3["FinalBalance_Sum"], np.nan)
            g_v3["RA_value"] = np.where(g_v3["Paying_Customers"] > 0, g_v3["Revenue_Sum"] / g_v3["Paying_Customers"], np.nan)
            combo_summaries_v3_i[tg] = g_v3

        # ── VA bot count chart ──
        va_bot_pieces_i, _, _, va_bot_client_totals_i = build_method_summary(
            inst_df, "va_bot_count", dep_col_i, "va_bot_cost", 0.0, "tier_group", tvol_col_i, final_bal_col_i, "cum_rec"
        )

        # Now plot combos, sms, vb for this institution (they append into the same PDF)
        _df_prior_i = df_prior[df_prior["institution"] == inst_name] if not df_prior.empty and "institution" in df_prior.columns else pd.DataFrame()
        if not _df_prior_i.empty:
            _df_prior_i = _df_prior_i.copy()
            # Institution-level charts redefine "tier_group" to mean client_bucket
            # (see inst_df["tier_group"] = inst_df["client_bucket"] above) — the prior
            # side must use the same redefinition, or every (tg, x) lookup here misses
            # entirely: current-period tg would be "High Amount, High Days" etc. while
            # prior-period tg would still be the original "Tier 0-2"/"Tier 3" labels.
            _df_prior_i["tier_group"] = _df_prior_i["client_bucket"]
        _prior_v1_i  = build_prior_combo_lookup(_df_prior_i, "Combo",    "tier_group")
        _prior_v2_i  = build_prior_combo_lookup(_df_prior_i, "Combo_v2", "tier_group")
        _prior_v3_i  = build_prior_combo_lookup(_df_prior_i, "Combo_v3", "tier_group")
        # Count-keyed (not Combo-keyed) lookups for the plain SMS/VB/VA Bot bubble
        # charts below, whose x-axis is a Count bucket, not a Combo label.
        _prior_sms_cnt_i   = build_prior_count_lookup(_df_prior_i, "sms_count",    "tier_group")
        _prior_vb_cnt_i    = build_prior_count_lookup(_df_prior_i, "vb_count",     "tier_group")
        _prior_smsvb_cnt_i = build_prior_count_lookup(_df_prior_i, "sms_vb_count", "tier_group")
        _prior_vabot_cnt_i = build_prior_count_lookup(_df_prior_i, "va_bot_count", "tier_group")
        plot_method("Combo (SMS + VB)", list(combo_summaries_i.items()), pp, inst_name, combo_client_totals_i, prior_lookup=_prior_v1_i)
        plot_method("Combo (WA + Email)", list(combo_summaries_v2_i.items()), pp, inst_name, combo_v2_client_totals_i, combo_order_override=combo_order_v2, prior_lookup=_prior_v2_i)
        plot_method("Combo (VA Bot + Agent)", list(combo_summaries_v3_i.items()), pp, inst_name, combo_v3_client_totals_i, combo_order_override=combo_order_v3, prior_lookup=_prior_v3_i)
        plot_method("SMS", sms_pieces_i, pp, inst_name, sms_client_totals_i, prior_lookup=_prior_sms_cnt_i)
        plot_method("SMS + VB only", sms_vb_pieces_i, pp, inst_name, sms_vb_client_totals_i, prior_lookup=_prior_smsvb_cnt_i)
        plot_method("VB", vb_pieces_i, pp, inst_name, vb_client_totals_i, prior_lookup=_prior_vb_cnt_i)
        plot_method("VA Bot", va_bot_pieces_i, pp, inst_name, va_bot_client_totals_i, prior_lookup=_prior_vabot_cnt_i)

    # Prior-period lookups for global charts
    _prior_lc_v1 = build_prior_combo_lookup(df_prior, "Combo",    "loan_category")
    _prior_lc_v2 = build_prior_combo_lookup(df_prior, "Combo_v2", "loan_category")
    _prior_lc_v3 = build_prior_combo_lookup(df_prior, "Combo_v3", "loan_category")
    _prior_la_v1 = build_prior_combo_lookup(df_prior, "Combo",    "amount_category")
    _prior_la_v2 = build_prior_combo_lookup(df_prior, "Combo_v2", "amount_category")
    _prior_la_v3 = build_prior_combo_lookup(df_prior, "Combo_v3", "amount_category")
    _prior_dp_v1 = build_prior_combo_lookup(df_prior, "Combo",    "dpd")
    _prior_dp_v2 = build_prior_combo_lookup(df_prior, "Combo_v2", "dpd")
    _prior_dp_v3 = build_prior_combo_lookup(df_prior, "Combo_v3", "dpd")

    # Count-keyed (not Combo-keyed) lookups for the plain SMS/VB/VA Bot bubble charts.
    _prior_lc_sms   = build_prior_count_lookup(df_prior, "sms_count",    "loan_category")
    _prior_lc_vb    = build_prior_count_lookup(df_prior, "vb_count",     "loan_category")
    _prior_lc_smsvb = build_prior_count_lookup(df_prior, "sms_vb_count", "loan_category")
    _prior_lc_vabot = build_prior_count_lookup(df_prior, "va_bot_count", "loan_category")
    _prior_la_sms   = build_prior_count_lookup(df_prior, "sms_count",    "amount_category")
    _prior_la_vb    = build_prior_count_lookup(df_prior, "vb_count",     "amount_category")
    _prior_la_smsvb = build_prior_count_lookup(df_prior, "sms_vb_count", "amount_category")
    _prior_la_vabot = build_prior_count_lookup(df_prior, "va_bot_count", "amount_category")
    _prior_dp_sms   = build_prior_count_lookup(df_prior, "sms_count",    "dpd")
    _prior_dp_vb    = build_prior_count_lookup(df_prior, "vb_count",     "dpd")
    _prior_dp_smsvb = build_prior_count_lookup(df_prior, "sms_vb_count", "dpd")
    _prior_dp_vabot = build_prior_count_lookup(df_prior, "va_bot_count", "dpd")

    add_text_page(pp, "Loan Type Overview (All Institutions)", [])
    plot_method("Combo (SMS + VB)", combo_by_loan_category, pp, institution="All Institutions", client_totals=combo_by_loan_category_client_totals, chart_color=loan_type_color, prior_lookup=_prior_lc_v1)
    plot_method("Combo (WA + Email)", combo_v2_by_loan_category, pp, institution="All Institutions", client_totals=combo_v2_by_loan_category_ct, chart_color=loan_type_color, combo_order_override=combo_order_v2, prior_lookup=_prior_lc_v2)
    plot_method("Combo (VA Bot + Agent)", combo_v3_by_loan_category, pp, institution="All Institutions", client_totals=combo_v3_by_loan_category_ct, chart_color=loan_type_color, combo_order_override=combo_order_v3, prior_lookup=_prior_lc_v3)
    plot_method("SMS", loan_category_pieces, pp, institution="All Institutions", client_totals=loan_category_client_totals, chart_color=loan_type_color, prior_lookup=_prior_lc_sms)
    plot_method("SMS + VB only", loan_category_pieces_sms_vb, pp, institution="All Institutions", client_totals=loan_category_sms_vb_client_totals, chart_color=loan_type_color, prior_lookup=_prior_lc_smsvb)
    plot_method("VB", loan_category_pieces_vb, pp, institution="All Institutions", client_totals=loan_category_vb_client_totals, chart_color=loan_type_color, prior_lookup=_prior_lc_vb)
    plot_method("VA Bot", va_bot_loan_cat_pieces, pp, institution="All Institutions", client_totals=va_bot_loan_cat_ct, chart_color=loan_type_color, prior_lookup=_prior_lc_vabot)

    add_text_page(pp, "Loan Amount Overview (All Institutions)", [])
    plot_method("Combo (SMS + VB)", combo_by_loan_amount, pp, institution="All Institutions", client_totals=combo_by_loan_amount_client_totals, chart_color=loan_amount_color, prior_lookup=_prior_la_v1)
    plot_method("Combo (WA + Email)", combo_v2_by_loan_amount, pp, institution="All Institutions", client_totals=combo_v2_by_loan_amount_ct, chart_color=loan_amount_color, combo_order_override=combo_order_v2, prior_lookup=_prior_la_v2)
    plot_method("Combo (VA Bot + Agent)", combo_v3_by_loan_amount, pp, institution="All Institutions", client_totals=combo_v3_by_loan_amount_ct, chart_color=loan_amount_color, combo_order_override=combo_order_v3, prior_lookup=_prior_la_v3)
    plot_method("SMS", loan_amount_pieces, pp, institution="All Institutions", client_totals=loan_amount_client_totals, chart_color=loan_amount_color, prior_lookup=_prior_la_sms)
    plot_method("SMS + VB only", loan_amount_pieces_sms_vb, pp, institution="All Institutions", client_totals=loan_amount_sms_vb_client_totals, chart_color=loan_amount_color, prior_lookup=_prior_la_smsvb)
    plot_method("VB", loan_amount_pieces_vb, pp, institution="All Institutions", client_totals=loan_amount_vb_client_totals, chart_color=loan_amount_color, prior_lookup=_prior_la_vb)
    plot_method("VA Bot", va_bot_loan_amt_pieces, pp, institution="All Institutions", client_totals=va_bot_loan_amt_ct, chart_color=loan_amount_color, prior_lookup=_prior_la_vabot)

    add_text_page(pp, "DPD Overview (All Institutions)", [])
    plot_method("Combo (SMS + VB)", combo_by_dpd, pp, institution="All Institutions", client_totals=combo_by_dpd_client_totals, chart_color=dpd_color, prior_lookup=_prior_dp_v1)
    plot_method("Combo (WA + Email)", combo_v2_by_dpd, pp, institution="All Institutions", client_totals=combo_v2_by_dpd_ct, chart_color=dpd_color, combo_order_override=combo_order_v2, prior_lookup=_prior_dp_v2)
    plot_method("Combo (VA Bot + Agent)", combo_v3_by_dpd, pp, institution="All Institutions", client_totals=combo_v3_by_dpd_ct, chart_color=dpd_color, combo_order_override=combo_order_v3, prior_lookup=_prior_dp_v3)
    plot_method("SMS", dpd_pieces, pp, institution="All Institutions", client_totals=dpd_client_totals, chart_color=dpd_color, prior_lookup=_prior_dp_sms)
    plot_method("SMS + VB only", dpd_pieces_sms_vb, pp, institution="All Institutions", client_totals=dpd_sms_vb_client_totals, chart_color=dpd_color, prior_lookup=_prior_dp_smsvb)
    plot_method("VB", dpd_pieces_vb, pp, institution="All Institutions", client_totals=dpd_vb_client_totals, chart_color=dpd_color, prior_lookup=_prior_dp_vb)
    plot_method("VA Bot", va_bot_dpd_pieces, pp, institution="All Institutions", client_totals=va_bot_dpd_ct, chart_color=dpd_color, prior_lookup=_prior_dp_vabot)

# ---- end replacement block ----

    

    

print(f"MODE: {mode.upper()} | Costs → SMS:{sms_cost_col or f'₦{COST_SMS_FALLBACK}/SMS'} | VB:{vb_cost_col or f'₦{COST_VB_FALLBACK}/VB'} | Saved PDF → {PDF_PATH}")

