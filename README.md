# TRIAGE-0

**AI alert triage agent. Proof of concept built in 60 minutes.**

A SOC analyst spends most of their day reading alerts that turn out to be noise. This is a working proof of concept of an agent that does the first pass investigation for them. The agent reads an incoming SIEM alert, decides which log sources to pull, retrieves them, correlates events across systems, enriches with threat intel, and writes a triage report that an analyst can act on.

This repo ships with a single fully worked scenario using synthetic data so the agent runs end to end the moment you set your API key.

## What it does

1. Loads a staged SIEM alert (password spray followed by successful login).
2. **Planning stage** Gemini reads the alert and decides which of four log sources to investigate and why.
3. **Retrieval stage** The agent pulls the chosen log files (auth logs, firewall logs, EDR logs, threat intel).
4. **Synthesis stage** Gemini correlates the retrieved evidence and streams a structured triage report with verdict, MITRE mapping, timeline, containment actions, and hunt queries.

All three stages stream to a dark dashboard in real time.

## Stack

Python 3.10+, Flask, Server Sent Events, `google-genai` SDK, vanilla HTML and JS, IBM Plex fonts. No build step.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and paste your Gemini API key
python app.py
```

Open `http://localhost:5000` and click **RUN TRIAGE**.

Get a free Gemini API key at https://aistudio.google.com/apikey

## What is real, what is mocked

| Component | Status |
| --- | --- |
| Agent reasoning loop | Real Gemini calls |
| Streaming UI | Real SSE |
| Two stage planning then synthesis | Real |
| Log retrieval | Mocked. Reads local JSON files. |
| SIEM connection | Mocked. Single staged alert. |
| Threat intel feeds | Mocked. Single JSON file. |

A production version would replace the JSON files with connectors to Splunk, Elastic, Sentinel, CrowdStrike, and a real TIP. The agent layer above stays largely the same.

## The scenario in this repo

A Tor exit node runs a password spray across 47 corp accounts. One user without MFA is compromised. The attacker pivots through VPN to a workstation, then laterally to a file server, archives 488 MB of Finance data with 7zip, and exfiltrates it over HTTPS to a Cobalt Strike C2 attributed to FIN8.

The agent reconstructs that full kill chain from the logs and outputs MITRE technique mappings and containment actions.

## Project structure

```
alert-triage-agent/
├── app.py              # Flask app and SSE endpoint
├── agent.py            # Two stage Gemini agent
├── data/               # Synthetic alert and logs
│   ├── alert.json
│   ├── auth_logs.json
│   ├── firewall_logs.json
│   ├── endpoint_logs.json
│   └── threat_intel.json
├── templates/index.html
├── static/style.css
├── static/app.js
├── requirements.txt
└── .env.example
```

## What a real version would need

Live SIEM webhook receiver, a vector store for historical alert similarity search, tool calling for retrieval instead of fixed file reads, human in the loop escalation for low confidence verdicts, an audit trail of every model call, RBAC, and pricing aware caching. None of that fits in 60 minutes.

## Contributors

- [@dev0558](https://github.com/dev0558) — Bhargav Raj Dutta, creator
- [@techtrail42](https://github.com/techtrail42)

## Credits

Built as a hackathon style POC. Synthetic data only. Not for production use.
