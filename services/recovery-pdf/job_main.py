"""
Cloud Run Job entrypoint for recovery PDF generation + email delivery.

Unlike main.py's Flask endpoints, there is no HTTP request/response here —
params arrive as environment variables (set via the Job execution's
containerOverrides when triggered through the Admin API's jobs.run), and the
whole process IS the background work. The exit code tells Cloud Run whether
the execution succeeded, so it can retry per the Job's --max-retries.

Expected env vars:
  JOB_TO                 comma-separated recipient emails (required)
  REPORT_DATE_FROM       YYYY-MM-DD
  REPORT_DATE_TO         YYYY-MM-DD
  REPORT_DEPOSIT_TO      YYYY-MM-DD, optional
  REPORT_INSTITUTIONS    comma-separated institution names, optional (empty = all)
"""
import os
import sys
import json
import tempfile
import traceback

from report_worker import build_env, run_script, send_email, build_subject_and_filename


def _data_from_env() -> dict:
    to = [t.strip() for t in os.environ.get('JOB_TO', '').split(',') if t.strip()]
    institutions = [i.strip() for i in os.environ.get('REPORT_INSTITUTIONS', '').split(',') if i.strip()]
    return {
        'to':           to,
        'dateFrom':     os.environ.get('REPORT_DATE_FROM',    '2026-04-11'),
        'dateTo':       os.environ.get('REPORT_DATE_TO',      '2026-04-18'),
        'depositTo':    os.environ.get('REPORT_DEPOSIT_TO',   ''),
        'institutions': institutions,
    }


def main() -> int:
    data = _data_from_env()
    if not data['to']:
        print('[job] ERROR: JOB_TO is empty — no recipients specified', flush=True)
        return 1

    subject, filename = build_subject_and_filename(data)

    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
        out_path = tmp.name
    try:
        env       = build_env(data, out_path)
        pdf_bytes = run_script(env, out_path)
        send_email(data['to'], subject, filename, pdf_bytes)
        print(f'[job] sent "{subject}" -> {data["to"]}', flush=True)
        return 0
    except Exception as e:
        tb = traceback.format_exc()
        print(f'[job] ERROR: {e}\n{tb}', flush=True)
        try:
            send_email(
                to=['emmanuel@fsldigital.com'],
                subject=f'[FSS Reports] Failed: {subject}',
                filename='error.txt',
                pdf_bytes=f'Job failed.\n\nParams: {json.dumps(data, indent=2)}\n\nError:\n{tb}'.encode(),
            )
        except Exception as mail_err:
            print(f'[job] could not send failure notification: {mail_err}', flush=True)
        return 1
    finally:
        try:
            os.unlink(out_path)
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
