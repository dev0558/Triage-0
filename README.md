# TRIAGE-0

Autonomous tier 1 SOC analyst. Reads an incoming SIEM alert, decides which logs to pull, queries them, correlates the evidence, and writes a triage report with a verdict.

## The problem

A tier 1 analyst spends most of the day reading alerts. Most of those alerts turn out to be false positives or already mitigated, but every one still needs someone to look at the logs, check the user baseline, enrich the indicators, and write up findings. That work is repetitive and follows the same investigative pattern every time. It is the obvious thing to automate, and the major SOC vendors (Dropzone AI, Prophet Security, Intezer, Red Canary, Scanner.dev) have all converged on the same architecture for it. This repo is a working version of that architecture, small enough to read in an afternoon.

## How the agent works

The agent runs a classic while loop with tool calls. On each iteration Gemini sees the alert plus everything it has learned so far, forms a hypothesis, and either calls one of five tools or stops and writes its conclusion. The five tools are query_auth_logs, query_firewall_logs, query_endpoint_logs, query_threat_intel, and query_user_baseline. Every tool call carries a rationale string so you can read what the agent was testing. The iteration budget is capped at 5.

When the agent stops calling tools, a separate streaming call writes the formal report. The transcript of every tool call and rationale is passed into that synthesis prompt so the report is grounded in the evidence the agent actually retrieved, not in things it might have imagined. The report has a fixed structure: verdict, confidence, severity, executive summary, attack timeline, MITRE mapping, affected assets, recommended actions, hunt queries, and analyst notes.

There are three possible verdicts. TRUE_POSITIVE is a real malicious event with confirmed impact. FALSE_POSITIVE is a benign event the rule misfired on. BENIGN_TRUE_POSITIVE is real activity that matches the rule but is authorized, expected, or already mitigated. This last category is what tells you the agent actually understood the context, not just pattern matched the rule name.

## The 5 alerts in the inbox

The five staged scenarios are designed so the agent has to reach a different verdict for each. The synthetic data is detailed enough that a careless agent would call all of them true positives. The point is to show that a good agent does not.

1. **ALR-001** Password spray from a Tor exit followed by successful login, lateral movement, archive creation, and 488 MB exfiltrated to a FIN8 C2. Expected verdict TRUE_POSITIVE Critical.
2. **ALR-002** Impossible travel from Dubai to Tokyo for a senior engineer. The user has an approved travel ticket on file, 47 prior Tokyo logins, and FIDO2 hardware key authentication. Expected verdict FALSE_POSITIVE.
3. **ALR-003** Unrecognised outbound traffic from a developer laptop to api.linear.app. IT recently rolled out Linear company wide. Threat intel on the domain is clean. Expected verdict BENIGN_TRUE_POSITIVE.
4. **ALR-004** 1247 failed RDP brute force attempts against an internet exposed bastion from a known DigitalOcean botnet range. Zero successful authentications. Expected verdict TRUE_POSITIVE Medium, contained.
5. **ALR-005** 47 employees receive a credential harvesting email from a newly registered Microsoft impersonation domain. Defender ZAP quarantines every copy before any click. 3 users report it manually. Expected verdict TRUE_POSITIVE High, mitigated.

Best demo pair is ALR-001 followed by ALR-002. Same authentication anomaly family, opposite verdicts, because the agent actually reads the user baseline instead of pattern matching the rule.

## Stack

Python 3.10+, Flask, Server Sent Events, google-genai SDK, vanilla HTML and CSS and JS. No build step. No frontend framework. The visual design is intentionally a paper case file rather than the usual dark SOC dashboard.

## Run it

```bash
git clone https://github.com/YOUR_USERNAME/triage-0.git
cd triage-0
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and paste your Gemini API key
PORT=5050 python app.py
```

Open http://localhost:5050. Pick an alert from the inbox on the left. Click BEGIN INVESTIGATION. Watch the iterations stream in.

Get a free Gemini API key at https://aistudio.google.com/apikey

The default model is gemini-2.5-flash-lite because the free tier allows 15 requests per minute on it versus only 5 for flash. If you have a paid tier or want flash quality, override with `GEMINI_MODEL=gemini-2.5-flash python app.py`. On macOS, the PORT override matters because AirPlay grabs port 5000.

## What is real and what is mocked

The Gemini calls are real. The agentic loop, the tool calling, the function declarations, the streaming synthesis, the SSE pipeline, the verdict extraction, and the inbox interaction are all real. The retry on 429 with backoff is real.

The log retrieval is mocked. Each tool reads a static JSON file under data/alerts/{ALR-ID}/. There is no SIEM connector, no real EDR, no live threat intel feed. A production version would replace those file reads with API calls to Splunk, Sentinel, CrowdStrike, MISP, and so on. The agent layer above does not change.

## What a production version would need

A live SIEM webhook receiver. Real tool implementations that query SIEM, EDR, identity providers, NGFW, and threat intel via API. Per environment context memory so the agent learns what is normal for your org. A vector store of past investigations for similarity search. Human in the loop escalation for low confidence verdicts. An audit trail of every model call, every tool input, and every tool output. Approval gates for any destructive action. RBAC. Cost tracking and rate limit budgeting per tenant.

## Disclaimer

Synthetic data only. Not for production. The logs, users, IPs, and incidents in this repo are fictional. If you want to use this as a starting point for something real, fork it and replace the data layer first.
