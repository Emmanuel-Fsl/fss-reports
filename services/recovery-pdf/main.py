import os
import base64
import json
import queue
import tempfile
import threading
from flask import Flask, request, Response, stream_with_context

from report_worker import build_env, run_script, send_email, build_subject_and_filename

app = Flask(__name__)


@app.post('/generate-and-email')
def generate_and_email():
    """
    Fire-and-forget endpoint for email delivery.
    Returns {ok: true} immediately; PDF generation + email happen in a background thread.

    Superseded by the recovery-pdf-job Cloud Run Job for the main frontend flow —
    kept here as a fallback HTTP path.
    """
    data = request.get_json(force=True)
    to = data.get('to', [])
    if not to:
        return {'error': 'No recipients specified'}, 400

    subject, filename = build_subject_and_filename(data)

    def worker():
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            out_path = tmp.name
        try:
            env       = build_env(data, out_path)
            pdf_bytes = run_script(env, out_path)
            send_email(to, subject, filename, pdf_bytes)
            print(f'[email] sent "{subject}" → {to}', flush=True)
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f'[email] ERROR: {e}\n{tb}', flush=True)
            try:
                send_email(
                    to=['emmanuel@fsldigital.com'],
                    subject=f'[FSS Reports] Failed: {subject}',
                    filename='error.txt',
                    pdf_bytes=f'Job failed.\n\nParams: {json.dumps(data, indent=2)}\n\nError:\n{tb}'.encode(),
                )
            except Exception as mail_err:
                print(f'[email] could not send failure notification: {mail_err}', flush=True)
        finally:
            try:
                os.unlink(out_path)
            except Exception:
                pass

    threading.Thread(target=worker, daemon=False).start()
    return {'ok': True}


@app.post('/generate')
def generate():
    data       = request.get_json(force=True)
    progress_q = queue.Queue()

    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
        out_path = f.name

    def worker():
        try:
            env       = build_env(data, out_path)
            pdf_bytes = run_script(env, out_path)
            progress_q.put({'type': 'done', 'pdf': base64.b64encode(pdf_bytes).decode()})
        except Exception as e:
            progress_q.put({'type': 'error', 'message': str(e)})
        finally:
            try:
                os.unlink(out_path)
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()

    def event_stream():
        while True:
            try:
                item = progress_q.get(timeout=10)
            except queue.Empty:
                yield ': keep-alive\n\n'
                continue
            yield f"data: {json.dumps(item)}\n\n"
            if item['type'] in ('done', 'error'):
                break

    return Response(
        stream_with_context(event_stream()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':     'no-cache',
            'X-Accel-Buffering': 'no',
            'Content-Type':      'text/event-stream',
        },
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
