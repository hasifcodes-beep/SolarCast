(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    lat: $("lat"), lon: $("lon"), forecastDays: $("forecastDays"),
    analyzeBtn: $("analyzeBtn"), status: $("status"), results: $("results"),
    modelWarning: $("modelWarning"),
    decisionCard: $("decisionCard"),
    actionUtilities: $("actionUtilities"),
    probBars: $("probBars"),
    summaryGrid: $("summaryGrid"),
    canvas: $("scoreChart"),
    tableBody: document.querySelector("#hourlyTable tbody"),
    fromNow: $("fromNow"),
  };

  const state = { chart: null, data: null };

  // ─── Helpers ────────────────────────────────────────
  function setStatus(msg, isError = false) {
    els.status.textContent = msg;
    els.status.classList.toggle("error", !!isError);
  }
  function fmtNum(v, d = 0) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    return Number(v).toFixed(d);
  }
  function fmtPct(v, d = 0) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    return (Number(v) * 100).toFixed(d) + "%";
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }
  function shortTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", hour: "2-digit", minute: "2-digit",
    });
  }
  function pillClass(label) {
    if (label === "High") return "pill-high";
    if (label === "Medium") return "pill-medium";
    return "pill-low";
  }

  // ─── Fetch ──────────────────────────────────────────
  async function analyze() {
    const body = {
      latitude: parseFloat(els.lat.value),
      longitude: parseFloat(els.lon.value),
      forecast_days: parseInt(els.forecastDays.value, 10),
    };
    if (!Number.isFinite(body.latitude) ||
        !Number.isFinite(body.longitude) ||
        !Number.isFinite(body.forecast_days)) {
      setStatus("Please fill in all fields with valid numbers.", true);
      return;
    }
    els.analyzeBtn.disabled = true;
    setStatus("Deciding…");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.hourly || !data.decision)
        throw new Error("Malformed response from backend.");
      state.data = data;
      render(data);
      setStatus(`Decision over ${data.hourly.length} hours · action = ${data.decision.action}`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`, true);
      els.results.classList.add("hidden");
    } finally {
      els.analyzeBtn.disabled = false;
    }
  }

  // ─── Render ─────────────────────────────────────────
  function render(data) {
    els.results.classList.remove("hidden");
    els.modelWarning.classList.toggle("hidden", data.model_loaded !== false);
    renderDecision(data);
    renderActionUtilities(data);
    renderProbabilityBars(data);
    renderSummary(data);
    renderTable(data);
    renderChart(data);
  }

  function renderDecision(data) {
    const d = data.decision;
    const pill = `<span class="pill ${pillClass(d.confidence_label)}">` +
                 `${d.confidence_label} · ${fmtPct(d.confidence, 0)}</span>`;

    const config = {
      run_now: {
        icon: "⚡", title: "RUN NOW",
        detail: `Utility at the current hour is <strong>${fmtNum(d.utility, 3)}</strong> ` +
                `(${fmtTime(d.hour_time)}), clearing the learned floor.`,
      },
      wait_until_best: {
        icon: "⏳", title: "WAIT UNTIL BEST HOUR",
        detail: `A future hour beats running now. Utility <strong>${fmtNum(d.utility, 3)}</strong> ` +
                `at <strong>${fmtTime(d.hour_time)}</strong>.`,
      },
      skip: {
        icon: "🚫", title: "SKIP",
        detail: `No hour in the horizon clears the learned floor ` +
                `(${fmtNum(data.constants.floor, 2)}). Utility = 0 for every action.`,
      },
    }[d.action];

    const u = d.action_utilities;
    const rationale =
      `U(run_now) = ${fmtNum(u.run_now, 3)} · ` +
      `U(wait_until_best) = ${fmtNum(u.wait_until_best, 3)} · ` +
      `U(skip) = 0.000  →  argmax = ${d.action}`;

    els.decisionCard.className = `decision-card action-${d.action}`;
    els.decisionCard.innerHTML = `
      <div class="decision-icon">${config.icon}</div>
      <div class="decision-body">
        <div class="action-line">${config.title} ${pill}</div>
        <div class="detail">${config.detail}</div>
        <div class="rationale">${rationale}</div>
      </div>`;
  }

  function renderActionUtilities(data) {
    const u = data.decision.action_utilities;
    const winner = data.decision.action;
    const rows = [
      { key: "run_now",         label: "run_now",         value: u.run_now,         cls: "" },
      { key: "wait_until_best", label: "wait_until_best", value: u.wait_until_best, cls: "" },
      { key: "skip",            label: "skip",            value: 0,                 cls: "is-skip" },
    ];
    els.actionUtilities.innerHTML = `
      <h3>Action utilities (argmax selects the winner)</h3>
      ${rows.map((r) => {
        const isWinner = r.key === winner;
        const pct = Math.max(0, Math.min(100, r.value * 100));
        return `
          <div class="utility-row ${isWinner ? "is-winner" : ""} ${r.cls}">
            <span class="utility-name">${r.label}${isWinner ? " ★" : ""}</span>
            <div class="utility-bar-wrap"><div class="utility-bar" style="width:${pct}%;"></div></div>
            <span class="utility-value">${fmtNum(r.value, 3)}</span>
          </div>`;
      }).join("")}`;
  }

  function renderProbabilityBars(data) {
    const idx = data.decision.hour_index != null
      ? data.decision.hour_index : data.now_index;
    const h = data.hourly[idx];
    const label = data.decision.hour_index != null ? "chosen hour" : "current hour";
    const bars = [
      { label: "P(GOOD)",     value: h.p_good,     cls: "prob-good" },
      { label: "P(MARGINAL)", value: h.p_marginal, cls: "prob-marginal" },
      { label: "P(NO)",       value: h.p_no,       cls: "prob-no" },
    ];
    els.probBars.innerHTML = `
      <h3>Model probabilities · ${label} (${fmtTime(h.time)})</h3>
      ${bars.map((b) => `
        <div class="prob-row ${b.cls}">
          <span class="prob-name">${b.label}</span>
          <div class="prob-bar-wrap">
            <div class="prob-bar" style="width:${Math.max(0, Math.min(100, b.value * 100))}%;"></div>
          </div>
          <span class="prob-value">${fmtPct(b.value, 1)}</span>
        </div>`).join("")}`;
  }

  function renderSummary(data) {
    const s = data.summary;
    const cards = [
      { label: "Peak GHI",     value: fmtNum(s.peak_ghi, 0),     unit: "W/m²", cls: "" },
      { label: "Peak Utility", value: fmtNum(s.peak_utility, 2), unit: "of 1.0", cls: "blue" },
      { label: "GOOD Hours",   value: s.good_hours,              unit: `of ${data.hourly.length}`, cls: "good" },
      { label: "MARGINAL",     value: s.marginal_hours,          unit: "", cls: "marginal" },
      { label: "NO Hours",     value: s.no_hours,                unit: "", cls: "no" },
    ];
    els.summaryGrid.innerHTML = cards.map((c) => `
      <div class="card ${c.cls}">
        <span class="label">${c.label}</span>
        <span class="value">${c.value}</span>
        <span class="unit">${c.unit}</span>
      </div>`).join("");
  }

  function renderTable(data) {
    const fromNow = els.fromNow.checked;
    const startIdx = fromNow ? data.now_index : 0;
    const chosenIdx = data.decision.hour_index;
    const rows = data.hourly.filter((h) => h.index >= startIdx);

    if (rows.length === 0) {
      els.tableBody.innerHTML =
        `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.5rem;">
           No hours to display.</td></tr>`;
      return;
    }
    els.tableBody.innerHTML = rows.map((h) => {
      const cls = [
        h.index === data.now_index ? "is-now" : "",
        h.index === chosenIdx ? "is-chosen" : "",
      ].filter(Boolean).join(" ");
      return `
        <tr class="${cls}">
          <td>${fmtTime(h.time)}${h.index === chosenIdx ? " ← chosen" : ""}</td>
          <td>${fmtNum(h.ghi, 0)}</td>
          <td>${fmtNum(h.rain, 0)}</td>
          <td>${fmtNum(h.score, 2)}</td>
          <td><span class="badge badge-${h.verdict.toLowerCase()}">${h.verdict}</span></td>
          <td><span class="pill ${pillClass(h.confidence_label)}">` +
             `${h.confidence_label} · ${fmtPct(h.confidence, 0)}</span></td>
        </tr>`;
    }).join("");
  }

  function renderChart(data) {
    const labels = data.hourly.map((h) => shortTime(h.time));
    const scores = data.hourly.map((h) => h.score);
    const ghi    = data.hourly.map((h) => h.ghi);
    const floor  = data.constants.floor;
    const good   = data.constants.good_threshold;

    if (state.chart) { state.chart.destroy(); state.chart = null; }
    const chosen = data.decision.hour_index;
    const chosenLabel = chosen !== null ? shortTime(data.hourly[chosen].time) : null;

    const annotations = {
      goodLine: {
        type: "line", yMin: good, yMax: good,
        borderColor: "rgba(34, 197, 94, 0.4)",
        borderWidth: 1, borderDash: [6, 4],
        label: { display: true, content: `GOOD (${good.toFixed(2)})`,
                 position: "start", color: "rgba(34, 197, 94, 0.85)",
                 backgroundColor: "transparent", font: { size: 10 } },
      },
      floorLine: {
        type: "line", yMin: floor, yMax: floor,
        borderColor: "rgba(239, 68, 68, 0.4)",
        borderWidth: 1, borderDash: [6, 4],
        label: { display: true, content: `FLOOR (${floor.toFixed(2)})`,
                 position: "start", color: "rgba(239, 68, 68, 0.85)",
                 backgroundColor: "transparent", font: { size: 10 } },
      },
    };
    if (chosenLabel) {
      annotations.chosen = {
        type: "line", scaleID: "x", value: chosenLabel,
        borderColor: "rgba(34, 197, 94, 0.8)", borderWidth: 2,
        label: { display: true, content: "★ chosen", position: "end",
                 color: "#22c55e", backgroundColor: "rgba(34, 197, 94, 0.15)",
                 font: { size: 11, weight: "600" } },
      };
    }

    const ctx = els.canvas.getContext("2d");
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Utility (expected goodness of running this hour)",
            data: scores, borderColor: "#fbbf24",
            backgroundColor: "rgba(251, 191, 36, 0.10)",
            borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
            fill: true, tension: 0.3, yAxisID: "y" },
          { label: "GHI (W/m²)", data: ghi,
            borderColor: "rgba(56, 189, 248, 0.55)",
            backgroundColor: "transparent", borderWidth: 1.5,
            borderDash: [4, 4], pointRadius: 0, fill: false,
            tension: 0.3, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#e2e8f0", usePointStyle: true, padding: 16 } },
          tooltip: { backgroundColor: "#1e293b", titleColor: "#fbbf24",
                     bodyColor: "#e2e8f0", borderColor: "#475569",
                     borderWidth: 1, padding: 10 },
          annotation: { annotations },
        },
        scales: {
          x: { ticks: { color: "#94a3b8", maxRotation: 45, autoSkip: true, maxTicksLimit: 24 },
               grid: { color: "rgba(148, 163, 184, 0.08)" } },
          y: { beginAtZero: true, max: 1.0,
               title: { display: true, text: "Utility (0–1)", color: "#94a3b8" },
               ticks: { color: "#94a3b8" },
               grid: { color: "rgba(148, 163, 184, 0.08)" } },
          y1: { position: "right", beginAtZero: true,
                title: { display: true, text: "GHI (W/m²)", color: "#38bdf8" },
                ticks: { color: "#38bdf8" }, grid: { display: false } },
        },
      },
    });
  }

  // ─── Events ─────────────────────────────────────────
  els.analyzeBtn.addEventListener("click", analyze);
  [els.lat, els.lon, els.forecastDays].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); analyze(); }
    });
  });
  els.fromNow.addEventListener("change", () => {
    if (state.data) renderTable(state.data);
  });

  analyze();
})();