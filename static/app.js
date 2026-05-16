// TRIAGE-0 frontend
// Drives the inbox, the case brief, and the streaming agent transcript.

(() => {

  // -------- state --------
  const state = {
    alerts: [],              // list of alert summaries
    selectedFolderId: null,  // currently active alert
    statusMap: {},           // folderId -> { status, verdict }
    filter: "all",
    running: false,
    reportMarkdown: "",
    es: null,                // EventSource
    currentIteration: null,  // DOM node for the active iteration block
  };

  // -------- helpers --------
  const $ = (id) => document.getElementById(id);
  const fmtUTC = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toUTCString().slice(17, 25);
  };
  const fmtUTCFull = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const date = d.toISOString().slice(0, 10);
    return `${date} ${d.toUTCString().slice(17, 25)} UTC`;
  };

  // -------- clock --------
  function tickClock() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const ss = String(now.getUTCSeconds()).padStart(2, "0");
    $("clock").textContent = `${hh}:${mm}:${ss} UTC`;
  }
  setInterval(tickClock, 1000);
  tickClock();

  // -------- inbox --------
  async function loadInbox() {
    try {
      const res = await fetch("/api/alerts");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const alerts = await res.json();
      state.alerts = alerts;
      // Initialize status map - all alerts start as NEW
      alerts.forEach((a) => {
        if (!state.statusMap[a.folder_id]) {
          state.statusMap[a.folder_id] = { status: "NEW", verdict: null };
        }
      });
      renderInbox();
    } catch (e) {
      $("inboxList").innerHTML = `<div class="inbox-loading">failed to load: ${e.message}</div>`;
    }
  }

  function renderInbox() {
    const list = $("inboxList");
    const filtered = state.alerts.filter((a) => {
      if (state.filter === "all") return true;
      const s = state.statusMap[a.folder_id];
      if (state.filter === "NEW") return s.status === "NEW";
      if (state.filter === "DONE") return s.status === "DONE";
      return true;
    });
    $("inboxCount").textContent = state.alerts.length;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="inbox-loading">no alerts match this filter</div>`;
      return;
    }

    list.innerHTML = filtered.map((a) => {
      const s = state.statusMap[a.folder_id];
      const isSel = a.folder_id === state.selectedFolderId ? " selected" : "";
      let statusBlock = "";
      if (s.status === "NEW") {
        statusBlock = `<div class="card-status NEW"><span class="dot"></span><span>NEW</span></div>`;
      } else if (s.status === "TRIAGING") {
        statusBlock = `<div class="card-status TRIAGING"><span class="dot"></span><span>TRIAGING...</span></div>`;
      } else if (s.status === "DONE") {
        const v = s.verdict || "DONE";
        statusBlock = `<div class="card-status DONE"><span class="dot"></span><span class="card-verdict ${v}">${v.replace(/_/g, " ")}</span></div>`;
      }
      return `
        <div class="inbox-card severity-${a.severity}${isSel}" data-folder="${a.folder_id}">
          <div class="card-id">${a.alert_id}</div>
          <div class="card-rule">${escapeHTML(a.rule_name)}</div>
          <span class="card-sev ${a.severity}">${a.severity}</span>
          <div class="card-meta">${fmtUTC(a.timestamp)} UTC · ${escapeHTML(a.user_account)}</div>
          ${statusBlock}
        </div>
      `;
    }).join("");

    list.querySelectorAll(".inbox-card").forEach((el) => {
      el.addEventListener("click", () => {
        if (state.running) return;
        selectAlert(el.dataset.folder);
      });
    });
  }

  // -------- filter pills --------
  document.querySelectorAll(".filter-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.filter = pill.dataset.filter;
      renderInbox();
    });
  });

  // -------- select / load alert --------
  async function selectAlert(folderId) {
    state.selectedFolderId = folderId;
    renderInbox();
    resetDossier();
    try {
      const res = await fetch(`/api/alert/${folderId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const alert = await res.json();
      renderAlert(alert);
      $("caseId").textContent = alert.alert_id;
      const runBtn = $("runBtn");
      runBtn.disabled = false;
      runBtn.querySelector(".begin-text").textContent = "BEGIN INVESTIGATION";
      $("beginHint").textContent = "synthetic data · ~30 seconds to complete";
    } catch (e) {
      $("alertBody").innerHTML = `<div class="placeholder">failed to load alert: ${e.message}</div>`;
    }
  }

  function resetDossier() {
    state.reportMarkdown = "";
    state.currentIteration = null;
    $("alertBody").innerHTML = `<div class="placeholder"><em>loading...</em></div>`;
    $("agentBody").innerHTML = `<div class="placeholder"><em>Agent reasoning, tool calls, and retrieval will appear here, in sequence.</em></div>`;
    $("reportBody").innerHTML = `<div class="placeholder"><em>Findings will be transcribed below once synthesis completes.</em></div>`;
    $("verdictBanner").hidden = true;
    $("alertState").textContent = "EMPTY"; $("alertState").className = "section-state";
    $("agentState").textContent = "IDLE"; $("agentState").className = "section-state";
    $("reportState").textContent = "PENDING"; $("reportState").className = "section-state";
    document.querySelectorAll(".pipeline .stage").forEach((s) => s.classList.remove("active", "complete"));
    setSystemStatus("standby", "STANDBY");
  }

  function renderAlert(alert) {
    const sev = alert.severity || "MEDIUM";
    const stampText = sev === "CRITICAL" ? "PRIORITY-0" : sev === "HIGH" ? "PRIORITY-1" : sev === "MEDIUM" ? "PRIORITY-2" : "PRIORITY-3";
    const tags = (alert.tags || []).map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join(" ");
    const destSystems = Array.isArray(alert.destination_systems) ? alert.destination_systems.join(", ") : (alert.destination_systems || "—");

    $("alertBody").innerHTML = `
      <article class="alert-card severity-${sev}" data-stamp="${stampText}">
        <div class="alert-id">${escapeHTML(alert.alert_id)} &middot; ${fmtUTCFull(alert.timestamp)}</div>
        <h3 class="alert-rule">${escapeHTML(alert.rule_name)}</h3>
        <span class="alert-severity ${sev}">${sev}</span>

        <dl class="alert-fields">
          <dt>Rule ID</dt><dd>${escapeHTML(alert.rule_id || "—")}</dd>
          <dt>SIEM</dt><dd>${escapeHTML(alert.siem_source || "—")}</dd>
          <dt>User</dt><dd>${escapeHTML(alert.user_account || "—")} (${escapeHTML(alert.user_display_name || "")})</dd>
          <dt>Department</dt><dd>${escapeHTML(alert.department || "—")}</dd>
          <dt>Source</dt><dd>${escapeHTML(alert.source_ip || "—")} (${escapeHTML(alert.source_geo || "")})</dd>
          <dt>Targets</dt><dd>${escapeHTML(destSystems)}</dd>
        </dl>

        <div class="alert-section-title">Description</div>
        <p class="alert-description">${escapeHTML(alert.description)}</p>

        <div class="alert-section-title">Raw Log Excerpt</div>
        <pre class="raw-log">${escapeHTML(alert.raw_log_excerpt || "—")}</pre>

        <div class="alert-section-title" style="margin-top: 18px;">Tags</div>
        <div class="tag-row">${tags || '<span class="tag">untagged</span>'}</div>
      </article>
    `;
    $("alertState").textContent = "LOADED"; $("alertState").className = "section-state done";
  }

  // -------- run triage --------
  $("runBtn").addEventListener("click", () => {
    if (state.running) return;
    if (!state.selectedFolderId) return;
    runTriage(state.selectedFolderId);
  });

  function runTriage(folderId) {
    state.running = true;
    state.reportMarkdown = "";
    state.currentIteration = null;

    // Update inbox card status
    state.statusMap[folderId].status = "TRIAGING";
    state.statusMap[folderId].verdict = null;
    renderInbox();

    // Reset agent/report panels
    $("agentBody").innerHTML = "";
    $("reportBody").innerHTML = "";
    $("verdictBanner").hidden = true;
    $("agentState").textContent = "RUNNING"; $("agentState").className = "section-state active";
    $("reportState").textContent = "PENDING"; $("reportState").className = "section-state";
    setSystemStatus("running", "INVESTIGATING");

    // Disable button during run
    const runBtn = $("runBtn");
    runBtn.disabled = true;
    runBtn.querySelector(".begin-text").textContent = "RUNNING...";

    state.es = new EventSource(`/api/triage/${folderId}`);
    state.es.onmessage = (e) => handleEvent(JSON.parse(e.data));
    state.es.onerror = () => {
      if (state.running) {
        appendAgentLine(`<div class="placeholder">stream interrupted</div>`);
      }
      teardown();
    };
  }

  function teardown() {
    state.running = false;
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    const runBtn = $("runBtn");
    runBtn.disabled = false;
    runBtn.querySelector(".begin-text").textContent = "RE-RUN INVESTIGATION";
  }

  // -------- event handler --------
  function handleEvent(evt) {
    switch (evt.type) {
      case "alert":
        // already loaded via /api/alert; nothing to do
        break;

      case "stage":
        activateStage(evt.stage);
        if (evt.stage === "synthesis") {
          $("agentState").textContent = "DONE"; $("agentState").className = "section-state done";
          $("reportState").textContent = "WRITING"; $("reportState").className = "section-state active";
          setSystemStatus("running", "SYNTHESIZING");
        }
        break;

      case "agent_thought":
        ensureIteration(evt.iteration);
        appendThought(evt.text);
        break;

      case "tool_call":
        ensureIteration(evt.iteration);
        appendToolCall(evt.name, evt.rationale);
        break;

      case "tool_result":
        appendToolResult(evt.name, evt.preview);
        break;

      case "investigation_done":
        appendAgentLine(`<div class="iteration-head" style="color: var(--ink); margin-top: 18px;">INVESTIGATION COMPLETE · ${evt.iterations_used} iteration${evt.iterations_used === 1 ? "" : "s"} used</div>`);
        break;

      case "report_chunk":
        appendReportChunk(evt.text);
        break;

      case "report_done":
        finalizeReport();
        $("reportState").textContent = "FILED"; $("reportState").className = "section-state done";
        break;

      case "done":
        activateStage("done");
        completeAllStages();
        const folderId = state.selectedFolderId;
        state.statusMap[folderId].status = "DONE";
        // verdict was already extracted in finalizeReport
        renderInbox();
        setSystemStatus("done", "FILED");
        teardown();
        break;

      case "error":
        appendAgentLine(`<div class="placeholder" style="color: var(--stamp-red);">ERROR: ${escapeHTML(evt.message)}</div>`);
        teardown();
        break;

      case "rate_limit_wait":
        appendAgentLine(`<div class="rate-wait">⏳ Rate limit hit · waiting ${evt.seconds}s · retry ${evt.attempt}/${evt.max}</div>`);
        setSystemStatus("running", `WAITING ${evt.seconds}s`);
        break;
    }
  }

  // -------- agent / iteration rendering --------
  function ensureIteration(n) {
    if (!state.currentIteration || state.currentIteration.dataset.iter !== String(n)) {
      // Mark previous iteration as inactive
      if (state.currentIteration) state.currentIteration.classList.remove("active");

      const block = document.createElement("div");
      block.className = "iteration-block active";
      block.dataset.iter = String(n);
      block.innerHTML = `<div class="iteration-head">ITERATION ${String(n).padStart(2, "0")}</div>`;
      $("agentBody").appendChild(block);
      state.currentIteration = block;
      block.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }

  function appendThought(text) {
    if (!state.currentIteration) ensureIteration(1);
    const div = document.createElement("div");
    div.className = "agent-thought";
    div.textContent = text;
    state.currentIteration.appendChild(div);
  }

  function appendToolCall(name, rationale) {
    if (!state.currentIteration) ensureIteration(1);
    const div = document.createElement("div");
    div.className = "tool-call";
    div.innerHTML = `
      <div class="tool-call-icon">▸</div>
      <div class="tool-call-body">
        <div class="tool-call-name">${escapeHTML(name)}()</div>
        ${rationale ? `<div class="tool-call-rationale">"${escapeHTML(rationale)}"</div>` : ""}
      </div>
    `;
    state.currentIteration.appendChild(div);
  }

  function appendToolResult(name, preview) {
    if (!state.currentIteration) return;
    const div = document.createElement("div");
    div.className = "tool-result";
    div.innerHTML = `<span class="check">✓</span><span>${escapeHTML(preview)}</span>`;
    state.currentIteration.appendChild(div);
  }

  function appendAgentLine(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    $("agentBody").appendChild(div);
  }

  // -------- report streaming --------
  function appendReportChunk(text) {
    state.reportMarkdown += text;
    renderReport(state.reportMarkdown, true);
    extractVerdictFromMarkdown(state.reportMarkdown);
  }

  function renderReport(md, withCursor) {
    const body = $("reportBody");
    body.className = "section-body report-body";
    let html = window.marked ? window.marked.parse(md) : `<pre>${escapeHTML(md)}</pre>`;
    if (withCursor) html += `<span class="report-cursor"></span>`;
    body.innerHTML = html;
  }

  function finalizeReport() {
    renderReport(state.reportMarkdown, false);
    extractVerdictFromMarkdown(state.reportMarkdown);
  }

  // -------- verdict extraction --------
  function extractVerdictFromMarkdown(md) {
    // Look for TRUE_POSITIVE / FALSE_POSITIVE / BENIGN_TRUE_POSITIVE in the early part of the markdown
    let verdict = null;
    if (/BENIGN_TRUE_POSITIVE/i.test(md)) verdict = "BENIGN_TRUE_POSITIVE";
    else if (/TRUE_POSITIVE/i.test(md)) verdict = "TRUE_POSITIVE";
    else if (/FALSE_POSITIVE/i.test(md)) verdict = "FALSE_POSITIVE";

    let confidence = null;
    const cm = md.match(/Confidence\s*[:\-]\s*\*{0,2}(HIGH|MEDIUM|LOW)/i);
    if (cm) confidence = cm[1].toUpperCase();

    if (verdict) {
      const banner = $("verdictBanner");
      banner.hidden = false;
      const vv = $("verdictValue");
      vv.textContent = verdict.replace(/_/g, " ");
      vv.className = `verdict-value ${verdict}`;
      $("verdictConfidence").textContent = confidence ? `CONFIDENCE · ${confidence}` : "CONFIDENCE · —";

      // store on the alert's status for inbox display
      if (state.selectedFolderId) {
        state.statusMap[state.selectedFolderId].verdict = verdict;
      }
    }
  }

  // -------- pipeline / status --------
  function activateStage(stage) {
    document.querySelectorAll(".pipeline .stage").forEach((s) => {
      s.classList.remove("active");
      if (s.dataset.stage === stage) s.classList.add("active");
    });
    // Mark earlier stages complete
    const order = ["planning", "investigating", "synthesis", "done"];
    const idx = order.indexOf(stage);
    document.querySelectorAll(".pipeline .stage").forEach((s) => {
      const sIdx = order.indexOf(s.dataset.stage);
      if (sIdx < idx) s.classList.add("complete");
    });
    // First two stages share UI - planning + investigating both light up the investigate stage
    if (stage === "planning") {
      document.querySelector('.pipeline .stage[data-stage="investigating"]').classList.add("active");
      document.querySelector('.pipeline .stage[data-stage="planning"]').classList.add("active");
    }
  }

  function completeAllStages() {
    document.querySelectorAll(".pipeline .stage").forEach((s) => {
      s.classList.remove("active");
      s.classList.add("complete");
    });
  }

  function setSystemStatus(cls, label) {
    const el = $("systemStatus");
    el.className = `status-dot ${cls === "standby" ? "" : cls}`;
    el.querySelector(".label").textContent = label;
  }

  // -------- utils --------
  function escapeHTML(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // -------- init --------
  loadInbox();

})();
