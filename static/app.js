(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    lat: $("lat"), lon: $("lon"), forecastDays: $("forecastDays"),
    locationPreset: $("locationPreset"),
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

  // ─── Friendly location presets ─────────────────────
  const PRESETS = {
    seri_iskandar: { lat: 4.3596,  lon: 100.9761, label: "Seri Iskandar, Perak 🇲🇾" },
    kuala_lumpur:  { lat: 3.1390,  lon: 101.6869, label: "Kuala Lumpur 🇲🇾" },
    penang:        { lat: 5.4141,  lon: 100.3288, label: "George Town, Penang 🇲🇾" },
    johor_bahru:   { lat: 1.4927,  lon: 103.7414, label: "Johor Bahru 🇲🇾" },
  };

  const state = {
    chart: null,
    data: null,
    locationLabel: PRESETS.seri_iskandar.label,
  };

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
    setStatus("Looking at the forecast…");
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
      const actionWord = {
        run_now: "run now",
        wait_until_best: "wait for a better hour",
        skip: "skip",
      }[data.decision.action] || data.decision.action;
      setStatus(`✅ Analysis complete — ${data.hourly.length} hours checked. Best choice: ${actionWord}.`);
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
    const loc = data.location || {};
    const locLine = loc.latitude != null
      ? `📍 ${state.locationLabel} · ${fmtNum(loc.latitude, 4)}°, ${fmtNum(loc.longitude, 4)}°`
      : `📍 ${state.locationLabel}`;

    const pill = `<span class="pill ${pillClass(d.confidence_label)}">` +
                 `${d.confidence_label} confidence · ${fmtPct(d.confidence, 0)}</span>`;

    const config = {
      run_now: {
        icon: "⚡",
        title: "RUN NOW",
        detail: `Utility this hour is <strong>${fmtNum(d.utility, 3)}</strong> ` +
                `(${fmtTime(d.hour_time)}) and clears the learned FLOOR.`,
        plain: "The sun is strong enough right now, and no upcoming hour beats it. " +
               "This is the best moment in the forecast to run your solar-powered equipment.",
      },
      wait_until_best: {
        icon: "⏳",
        title: "WAIT — BEST HOUR AHEAD",
        detail: `A future hour beats running now. Utility <strong>${fmtNum(d.utility, 3)}</strong> ` +
                `at <strong>${fmtTime(d.hour_time)}</strong>.`,
        plain: "Conditions will improve later. Hold off for now, then run your equipment at the " +
               "highlighted hour — that's when the sun will be strongest.",
      },
      skip: {
        icon: "🚫",
        title: "SKIP — NOT WORTH IT",
        detail: `No hour in the horizon clears the learned FLOOR ` +
                `(${fmtNum(data.constants.floor, 2)}). Utility = 0 for every hour.`,
        plain: "The forecast looks too cloudy or dark at every hour. Running solar equipment " +
               "probably won't work well — consider skipping, or check again in a few hours.",
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
        <div class="decision-meta">${locLine}</div>
        <div class="action-line">${config.title} ${pill}</div>
        <div class="detail">${config.detail}</div>
        <div class="decision-plain">
          <span class="plain-label">💡 What this means</span>
          ${config.plain}
        </div>
        <div class="rationale">${rationale}</div>
      </div>`;
  }

  function renderActionUtilities(data) {
    const u = data.decision.action_utilities;
    const winner = data.decision.action;
    const rows = [
      { key: "run_now",         label: "run now",         value: u.run_now,         icon: "⚡" },
      { key: "wait_until_best", label: "wait for best",   value: u.wait_until_best, icon: "⏳" },
      { key: "skip",            label: "skip",            value: 0,                 icon: "🚫" },
    ];
    els.actionUtilities.innerHTML = `
      <h3>
        <span class="section-icon">🎯</span>
        Which option wins?
        <span class="panel-hint">Each option is scored 0–1. The tallest bar is the tool's recommendation.</span>
      </h3>
      ${rows.map((r) => {
        const isWinner = r.key === winner;
        const pct = Math.max(0, Math.min(100, r.value * 100));
        return `
          <div class="utility-row ${isWinner ? "is-winner" : ""} ${r.key === "skip" ? "is-skip" : ""}">
            <span class="utility-name"><span class="utility-icon">${r.icon}</span>${r.label}${isWinner ? " ★" : ""}</span>
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
      { label: "GOOD",     value: h.p_good,     cls: "prob-good" },
      { label: "MARGINAL", value: h.p_marginal, cls: "prob-marginal" },
      { label: "NO",       value: h.p_no,       cls: "prob-no" },
    ];
    els.probBars.innerHTML = `
      <h3>
        <span class="section-icon">🔮</span>
        What the model predicts · ${label} (${fmtTime(h.time)})
        <span class="panel-hint">Each bar is the model's estimated chance that this hour falls into that category.</span>
      </h3>
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
      { label: "Brightest hour", value: fmtNum(s.peak_ghi, 0),     unit: "W/m² (sunlight)", cls: "ghi",      icon: "☀️" },
      { label: "Best utility score", value: fmtNum(s.peak_utility, 2), unit: "of 1.0",     cls: "",         icon: "⚡" },
      { label: "Good hours",   value: s.good_hours,              unit: `of ${data.hourly.length}`, cls: "good", icon: "✅" },
      { label: "Marginal hours", value: s.marginal_hours,        unit: "",           cls: "marginal", icon: "⚠️" },
      { label: "No-go hours",  value: s.no_hours,                unit: "",           cls: "no",       icon: "❌" },
    ];
    els.summaryGrid.innerHTML = cards.map((c) => `
      <div class="card ${c.cls}">
        <div class="card-header">
          <span class="card-icon">${c.icon}</span>
          <span class="label">${c.label}</span>
        </div>
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
        borderColor: "rgba(74, 222, 128, 0.45)",
        borderWidth: 1, borderDash: [6, 4],
        label: { display: true, content: `GOOD (${good.toFixed(2)})`,
                 position: "start", color: "rgba(134, 239, 172, 0.9)",
                 backgroundColor: "transparent", font: { size: 10, weight: "600" } },
      },
      floorLine: {
        type: "line", yMin: floor, yMax: floor,
        borderColor: "rgba(248, 113, 113, 0.45)",
        borderWidth: 1, borderDash: [6, 4],
        label: { display: true, content: `FLOOR (${floor.toFixed(2)})`,
                 position: "start", color: "rgba(248, 113, 113, 0.9)",
                 backgroundColor: "transparent", font: { size: 10, weight: "600" } },
      },
    };
    if (chosenLabel) {
      annotations.chosen = {
        type: "line", scaleID: "x", value: chosenLabel,
        borderColor: "rgba(251, 146, 60, 0.9)", borderWidth: 2,
        label: { display: true, content: "★ chosen", position: "end",
                 color: "#fdba74", backgroundColor: "rgba(251, 146, 60, 0.18)",
                 font: { size: 11, weight: "600" } },
      };
    }

    const ctx = els.canvas.getContext("2d");
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "⚡ Utility score (0–1, higher is better)",
            data: scores,
            borderColor: "#fb923c",
            backgroundColor: (context) => {
              const chart = context.chart;
              const { ctx: c, chartArea } = chart;
              if (!chartArea) return "rgba(251, 146, 60, 0.12)";
              const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, "rgba(251, 146, 60, 0.38)");
              g.addColorStop(0.7, "rgba(251, 146, 60, 0.08)");
              g.addColorStop(1, "rgba(251, 146, 60, 0.0)");
              return g;
            },
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: "#fdba74",
            pointHoverBorderColor: "#fff",
            pointHoverBorderWidth: 2,
            fill: true, tension: 0.35, yAxisID: "y" },
          { label: "☀️ Sunlight — GHI (W/m²)",
            data: ghi,
            borderColor: "rgba(125, 211, 252, 0.7)",
            backgroundColor: "transparent", borderWidth: 1.5,
            borderDash: [4, 4], pointRadius: 0, pointHoverRadius: 4,
            pointHoverBackgroundColor: "#7dd3fc",
            fill: false,
            tension: 0.35, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: {
              color: "#d6c5b5",
              usePointStyle: true,
              pointStyle: "circle",
              padding: 16,
              font: { size: 12, family: "Inter, system-ui, sans-serif" },
            },
          },
          tooltip: {
            backgroundColor: "rgba(26, 18, 12, 0.96)",
            titleColor: "#fdba74",
            bodyColor: "#f5ebdd",
            borderColor: "rgba(251, 146, 60, 0.35)",
            borderWidth: 1, padding: 12, cornerRadius: 8,
            titleFont: { family: "Space Grotesk, Inter, sans-serif", weight: "600" },
            bodyFont: { family: "Inter, system-ui, sans-serif" },
          },
          annotation: { annotations },
        },
        scales: {
          x: {
            ticks: { color: "#b09a85", maxRotation: 45, autoSkip: true, maxTicksLimit: 24,
                     font: { size: 11 } },
            grid: { color: "rgba(176, 154, 133, 0.07)" },
            border: { color: "rgba(176, 154, 133, 0.15)" },
          },
          y: {
            beginAtZero: true, max: 1.0,
            title: { display: true, text: "Utility score (0–1)", color: "#b09a85",
                     font: { size: 11, weight: "600" } },
            ticks: { color: "#b09a85", font: { size: 11 } },
            grid: { color: "rgba(176, 154, 133, 0.07)" },
            border: { color: "rgba(176, 154, 133, 0.15)" },
          },
          y1: {
            position: "right", beginAtZero: true,
            title: { display: true, text: "Sunlight GHI (W/m²)", color: "#7dd3fc",
                     font: { size: 11, weight: "600" } },
            ticks: { color: "#7dd3fc", font: { size: 11 } },
            grid: { display: false },
            border: { color: "rgba(125, 211, 252, 0.15)" },
          },
        },
      },
    });
  }

  // ─── Location preset handling ──────────────────────
  function syncPresetFromCoords() {
    const lat = parseFloat(els.lat.value);
    const lon = parseFloat(els.lon.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let matched = null;
    for (const [key, p] of Object.entries(PRESETS)) {
      if (Math.abs(p.lat - lat) < 0.01 && Math.abs(p.lon - lon) < 0.01) {
        matched = key;
        break;
      }
    }
    if (matched) {
      els.locationPreset.value = matched;
      state.locationLabel = PRESETS[matched].label;
    } else {
      els.locationPreset.value = "custom";
      state.locationLabel = "Custom coordinates";
    }
  }

  els.locationPreset.addEventListener("change", () => {
    const key = els.locationPreset.value;
    const preset = PRESETS[key];
    if (preset) {
      els.lat.value = preset.lat;
      els.lon.value = preset.lon;
      state.locationLabel = preset.label;
      analyze(); // auto-refresh when the user picks a preset
    } else {
      state.locationLabel = "Custom coordinates";
      els.lat.focus();
      els.lat.select();
    }
  });

  [els.lat, els.lon].forEach((inp) => {
    inp.addEventListener("input", syncPresetFromCoords);
  });

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

  // Initialize the label to match whatever's in the lat/lon boxes.
  syncPresetFromCoords();
  analyze();
})();