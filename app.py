"""
Flask app for the Alert Triage Agent.
Serves the dossier UI and streams agent events over SSE.
"""

import json
import os
from flask import Flask, render_template, Response, stream_with_context, jsonify, request
from dotenv import load_dotenv

load_dotenv()

from agent import run_triage, list_alerts, get_alert

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/alerts")
def api_alerts():
    """List of all alerts in the inbox."""
    return jsonify(list_alerts())


@app.route("/api/alert/<folder_id>")
def api_alert(folder_id):
    try:
        return jsonify(get_alert(folder_id))
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/triage/<folder_id>")
def api_triage(folder_id):
    """SSE stream of the triage pipeline for a specific alert."""

    @stream_with_context
    def event_stream():
        try:
            for event in run_triage(folder_id):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return Response(
        event_stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
