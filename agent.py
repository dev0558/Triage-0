"""
Alert Triage Agent v2
Real agentic loop with Gemini function calling.

Architecture:
  1. List alerts, pick one
  2. Investigation loop (max 8 iterations)
       - Agent decides which tool to call based on accumulated context
       - Tools return synthetic log data
       - Agent forms hypotheses, queries to confirm or refute, repeats
  3. Synthesis call streams the final formal triage report with verdict
"""

import os
import json
from pathlib import Path
from google import genai
from google.genai import types

DATA_DIR = Path(__file__).parent / "data" / "alerts"
# Default to flash-lite for higher free-tier RPM (15 vs 5 for flash).
# Override via GEMINI_MODEL env var if you are on a paid tier.
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
MAX_TOOL_ITERATIONS = 5

# ---------------------------------------------------------------------------
# Tool definitions exposed to the model
# ---------------------------------------------------------------------------

TOOL_DECLARATIONS = [
    types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name="query_auth_logs",
            description="Retrieve authentication events (Active Directory, VPN gateway, RDP, Azure AD) related to this alert. Use this to verify password spray, impossible travel, brute force, MFA bypass, lateral movement, or to confirm a login is normal.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rationale": types.Schema(type=types.Type.STRING, description="Short hypothesis you are testing with this query.")
                },
                required=["rationale"]
            )
        ),
        types.FunctionDeclaration(
            name="query_firewall_logs",
            description="Retrieve perimeter NGFW traffic logs related to this alert. Use this to confirm inbound attacker traffic, anomalous outbound data volume, connections to known bad infrastructure, or to verify no suspicious egress occurred.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rationale": types.Schema(type=types.Type.STRING, description="Short hypothesis you are testing with this query.")
                },
                required=["rationale"]
            )
        ),
        types.FunctionDeclaration(
            name="query_endpoint_logs",
            description="Retrieve EDR telemetry from affected hosts (process tree, command lines, file operations, network connections from host, email security events). Use this to inspect what happened on the endpoint after the alert.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rationale": types.Schema(type=types.Type.STRING, description="Short hypothesis you are testing with this query.")
                },
                required=["rationale"]
            )
        ),
        types.FunctionDeclaration(
            name="query_threat_intel",
            description="Enrich IP addresses, domains, hashes, or other indicators against external and internal threat intelligence feeds. Use this to determine reputation, attribution, known campaigns, and breach history.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rationale": types.Schema(type=types.Type.STRING, description="Short hypothesis you are testing with this query.")
                },
                required=["rationale"]
            )
        ),
        types.FunctionDeclaration(
            name="query_user_baseline",
            description="Retrieve the affected user's behavioral baseline, IT ticket history, approved travel requests, MFA enrollment status, and approved corporate tools. Use this to determine whether observed behavior is anomalous or consistent with the user's normal pattern.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rationale": types.Schema(type=types.Type.STRING, description="Short hypothesis you are testing with this query.")
                },
                required=["rationale"]
            )
        ),
    ])
]

TOOL_TO_FILE = {
    "query_auth_logs": "auth_logs",
    "query_firewall_logs": "firewall_logs",
    "query_endpoint_logs": "endpoint_logs",
    "query_threat_intel": "threat_intel",
    "query_user_baseline": "user_baseline",
}


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior Tier 1 SOC analyst investigating a security alert. Your job is to triage the alert, determine whether it represents a real threat, and produce a verdict.

You have a budget of up to 8 tool calls. Use them strategically:
- Form a hypothesis about the alert before each query.
- Each tool call should test something specific. Don't query everything blindly.
- After 2 to 5 queries you should usually have enough to form a verdict.
- Stop calling tools when you have sufficient evidence. Do not over-investigate.

Possible verdicts:
- TRUE_POSITIVE: a real malicious event with confirmed adversary activity or impact.
- FALSE_POSITIVE: the alert fired on benign activity that looked suspicious but is fully explained by legitimate behavior.
- BENIGN_TRUE_POSITIVE: the activity is real and matches the rule, but it is authorized, expected, or already mitigated (e.g. quarantined, blocked, contained).

Be precise. Don't fabricate evidence. If something is unknown, say so. When you finish your investigation and are ready to deliver a verdict, respond with text (no more tool calls) describing your findings briefly. The formal report will be generated separately."""


# ---------------------------------------------------------------------------
# Client and data helpers
# ---------------------------------------------------------------------------

def _client():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")
    return genai.Client(api_key=api_key)


def list_alerts():
    """Summary of every alert in the inbox."""
    out = []
    for alert_dir in sorted(DATA_DIR.iterdir()):
        if not alert_dir.is_dir():
            continue
        alert = json.loads((alert_dir / "alert.json").read_text())
        out.append({
            "alert_id": alert["alert_id"],
            "folder_id": alert_dir.name,
            "rule_name": alert["rule_name"],
            "severity": alert["severity"],
            "timestamp": alert["timestamp"],
            "user_account": alert.get("user_account", "n/a"),
            "user_display_name": alert.get("user_display_name", ""),
            "siem_source": alert["siem_source"],
        })
    # Most recent first
    out.sort(key=lambda x: x["timestamp"], reverse=True)
    return out


def get_alert(folder_id):
    alert_dir = DATA_DIR / folder_id
    if not alert_dir.exists():
        raise FileNotFoundError(f"Alert folder not found: {folder_id}")
    return json.loads((alert_dir / "alert.json").read_text())


def _load_log(folder_id, source):
    path = DATA_DIR / folder_id / f"{source}.json"
    if not path.exists():
        return {"error": f"no {source} available for this alert"}
    return json.loads(path.read_text())


def _preview(data):
    """One-line preview string of a log payload for the UI."""
    if not isinstance(data, dict):
        return "data retrieved"
    if "events" in data and isinstance(data["events"], list):
        n = len(data["events"])
        src = data.get("source", "unknown source")
        return f"{n} events from {src}"
    if "queried_indicators" in data:
        return f"{len(data['queried_indicators'])} indicators enriched"
    if "user" in data:
        return f"baseline for {data.get('display_name') or data['user']}"
    return "data retrieved"


# ---------------------------------------------------------------------------
# Retry helper for 429 rate limits
# ---------------------------------------------------------------------------

def _call_with_retry(client, model, contents, config, max_retries=3):
    """
    Generator that calls generate_content with retry on 429 RESOURCE_EXHAUSTED.
    Yields:
      {"type": "rate_limit_wait", "seconds": N, "attempt": K} while waiting
      {"type": "_response", "response": ...} on success
      {"type": "error", "message": "..."} on terminal failure
    """
    import time
    import re

    for attempt in range(max_retries + 1):
        try:
            response = client.models.generate_content(model=model, contents=contents, config=config)
            yield {"type": "_response", "response": response}
            return
        except Exception as e:
            err_str = str(e)
            is_rate_limit = "429" in err_str or "RESOURCE_EXHAUSTED" in err_str
            if not is_rate_limit or attempt == max_retries:
                yield {"type": "error", "message": err_str}
                return
            # Try to parse the retry delay from the error payload
            m = re.search(r"['\"]retryDelay['\"]:\s*['\"]?(\d+)s?['\"]?", err_str)
            wait_seconds = int(m.group(1)) + 2 if m else (15 * (attempt + 1))
            yield {"type": "rate_limit_wait", "seconds": wait_seconds, "attempt": attempt + 1, "max": max_retries}
            time.sleep(wait_seconds)


# ---------------------------------------------------------------------------
# Investigation loop
# ---------------------------------------------------------------------------

def run_triage(folder_id):
    """Top-level generator. Yields a stream of events for the UI."""
    alert = get_alert(folder_id)
    yield {"type": "alert", "alert": alert}
    yield {"type": "stage", "stage": "planning"}

    client = _client()

    initial_user_message = (
        f"Incoming alert for triage. Investigate it.\n\n"
        f"ALERT JSON:\n```json\n{json.dumps(alert, indent=2)}\n```\n\n"
        f"Begin your investigation. Form a hypothesis and call the most useful tool first."
    )

    contents = [types.Content(role="user", parts=[types.Part.from_text(text=initial_user_message)])]

    config = types.GenerateContentConfig(
        tools=TOOL_DECLARATIONS,
        system_instruction=SYSTEM_PROMPT,
        temperature=0.2,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )

    investigation_transcript = []
    final_text = ""
    iteration = 0

    for iteration in range(MAX_TOOL_ITERATIONS):
        response = None
        for retry_event in _call_with_retry(client, MODEL, contents, config):
            if retry_event["type"] == "_response":
                response = retry_event["response"]
            elif retry_event["type"] == "rate_limit_wait":
                yield retry_event
            elif retry_event["type"] == "error":
                yield {"type": "error", "message": f"Gemini call failed at iteration {iteration}: {retry_event['message']}"}
                return

        if response is None:
            yield {"type": "error", "message": f"No response received at iteration {iteration}"}
            return

        candidate = response.candidates[0]
        parts = candidate.content.parts or []

        text_parts = [p.text for p in parts if getattr(p, "text", None)]
        function_call_parts = [p.function_call for p in parts if getattr(p, "function_call", None)]

        # Any narrative text the agent produced this turn
        if text_parts:
            joined = "".join(text_parts)
            yield {"type": "agent_thought", "iteration": iteration + 1, "text": joined}
            investigation_transcript.append({"role": "agent_thought", "text": joined})
            final_text = joined  # most recent thought; will be replaced if more come

        # No function calls means the agent considers itself done
        if not function_call_parts:
            break

        # Otherwise: execute every requested tool, append responses, continue
        contents.append(candidate.content)
        function_response_parts = []

        for fc in function_call_parts:
            args = dict(fc.args) if fc.args else {}
            tool_name = fc.name
            rationale = args.get("rationale", "")

            yield {
                "type": "tool_call",
                "iteration": iteration + 1,
                "name": tool_name,
                "rationale": rationale,
            }

            source = TOOL_TO_FILE.get(tool_name)
            if not source:
                result = {"error": f"unknown tool: {tool_name}"}
            else:
                result = _load_log(folder_id, source)

            yield {
                "type": "tool_result",
                "iteration": iteration + 1,
                "name": tool_name,
                "preview": _preview(result),
            }

            investigation_transcript.append({
                "role": "tool",
                "name": tool_name,
                "rationale": rationale,
                "result_preview": _preview(result),
            })

            function_response_parts.append(
                types.Part.from_function_response(name=tool_name, response={"result": json.dumps(result)})
            )

        contents.append(types.Content(role="user", parts=function_response_parts))

    yield {"type": "investigation_done", "iterations_used": iteration + 1, "final_thought": final_text}

    # -----------------------------------------------------------------------
    # Synthesis: ask Gemini to produce the formal report based on the transcript
    # -----------------------------------------------------------------------

    yield {"type": "stage", "stage": "synthesis"}

    transcript_for_synthesis = json.dumps(investigation_transcript, indent=2)

    synthesis_prompt = f"""You just completed an autonomous investigation of the following alert.

ALERT:
```json
{json.dumps(alert, indent=2)}
```

INVESTIGATION TRANSCRIPT (your tool calls, rationales, and intermediate thoughts):
```json
{transcript_for_synthesis}
```

YOUR FINAL INTERMEDIATE CONCLUSION:
{final_text}

Now write the formal triage report in Markdown. Use the following exact structure and headings.

## Verdict
First line: one of `TRUE_POSITIVE`, `FALSE_POSITIVE`, or `BENIGN_TRUE_POSITIVE` in a code block.
Then in a separate line: `Confidence: HIGH` or `MEDIUM` or `LOW`.
Then one sentence justifying the verdict.

## Confirmed Severity
One of Critical, High, Medium, Low. One sentence reason. If you are downgrading or upgrading the original severity, say so explicitly.

## Executive Summary
Two to three sentences a security manager could read in 10 seconds.

## Attack Timeline
Bulleted timeline in UTC, oldest first. Include real timestamps and IPs from the evidence. If the verdict is FALSE_POSITIVE or BENIGN_TRUE_POSITIVE, the timeline should show the benign chain of events.

## MITRE ATT&CK Mapping
Comma separated technique IDs observed, each with a one phrase note. If the verdict is FALSE_POSITIVE, write "Not applicable - no malicious technique observed."

## Affected Assets and Identities
Bulleted list of users, hosts, IPs, domains involved.

## Recommended Actions
Three to five concrete actions ordered by urgency. For FALSE_POSITIVE, this might include detection tuning rather than containment.

## Recommended Hunt Queries
Two to three follow up queries an analyst should run, expressed in plain English.

## Analyst Notes
Two sentences of context, caveats, or attribution.

Be precise. Use real timestamps and IPs from the transcript. Do not hedge if the evidence is clear. Do not invent facts not present in the transcript."""

    import time
    import re as _re

    synthesis_config = types.GenerateContentConfig(temperature=0.2)
    streamed_ok = False
    for attempt in range(4):  # up to 3 retries
        try:
            for chunk in client.models.generate_content_stream(
                model=MODEL,
                contents=synthesis_prompt,
                config=synthesis_config,
            ):
                if chunk.text:
                    yield {"type": "report_chunk", "text": chunk.text}
            streamed_ok = True
            break
        except Exception as e:
            err_str = str(e)
            is_rate_limit = "429" in err_str or "RESOURCE_EXHAUSTED" in err_str
            if not is_rate_limit or attempt == 3:
                yield {"type": "error", "message": f"Synthesis call failed: {err_str}"}
                return
            m = _re.search(r"['\"]retryDelay['\"]:\s*['\"]?(\d+)s?['\"]?", err_str)
            wait_seconds = int(m.group(1)) + 2 if m else (15 * (attempt + 1))
            yield {"type": "rate_limit_wait", "seconds": wait_seconds, "attempt": attempt + 1, "max": 3}
            time.sleep(wait_seconds)

    if not streamed_ok:
        yield {"type": "error", "message": "Synthesis stream did not complete"}
        return

    yield {"type": "report_done"}
    yield {"type": "done"}
