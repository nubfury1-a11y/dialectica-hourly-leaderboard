(() => {
  const COLORS = ["#5ee1c1", "#7aa9ff", "#f5c56b", "#d58cff", "#ff8292"];
  const DATA_URL = "./data/leaderboard.json";
  const $ = (selector) => document.querySelector(selector);
  const money = (value, signed = true) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    const digits = Math.abs(n) >= 1000 ? 1 : 2;
    return `${signed && n > 0 ? "+" : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
  };
  const count = (value) => value === null || value === undefined ? "—" : Number(value).toLocaleString();
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  let sortKey = null;
  let sortDirection = -1;
  let chart = null;
  let dashboard = null;
  let loadInProgress = false;
  let queuedManualReload = false;
  let noticeTimer = null;

  function setNotice(message, kind = "info") {
    if (noticeTimer) {
      window.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    const el = $("#notice");
    if (!message) {
      el.textContent = "";
      el.className = "notice";
      return;
    }
    el.textContent = message;
    el.className = `notice show${kind === "error" ? " error" : ""}`;
  }

  function renderTable(agents) {
    const sorted = [...agents];
    if (sortKey) {
      sorted.sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
        if (bv === null || bv === undefined) return -1;
        return (Number(av) - Number(bv)) * sortDirection;
      });
    }
    $("#table-count").textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
    if (!sorted.length) {
      $("#agent-rows").innerHTML = '<tr><td colspan="6"><div class="empty-state">No agent data has been collected yet.</div></td></tr>';
      return;
    }
    $("#agent-rows").innerHTML = sorted.map((agent, index) => {
      const unavailable = !agent.found;
      return `<tr>
        <td><div class="agent-cell"><span class="rank ${index === 0 && !unavailable ? "top" : ""}">${String(index + 1).padStart(2, "0")}</span><div><div class="agent-name">${esc(agent.name)}</div><div class="agent-label">${unavailable ? "Not found in public top 100" : `Public rank #${esc(agent.source_rank ?? "—")}`}</div></div></div></td>
        <td class="${agent.earned_1h > 0 ? "metric-up" : ""}">${money(agent.earned_1h)}</td>
        <td class="${agent.earned_24h > 0 ? "metric-up" : ""}">${money(agent.earned_24h)}</td>
        <td>${money(agent.total_trued, false)}</td>
        <td>${agent.verified_1h === null ? "—" : `${agent.verified_1h > 0 ? "+" : ""}${count(agent.verified_1h)}`}</td>
        <td>${count(agent.verified_answers)}</td>
      </tr>`;
    }).join("");
  }

  function cumulativeSeries(data) {
    // Saved progress is the lifetime total in each snapshot. Plotting the
    // per-snapshot *change* instead makes the lines fall back to zero after
    // every gain, which reads as lost progress even though history is saved.
    const history = Array.isArray(data?.history) ? data.history : [];
    const names = (data?.agents || []).map((agent) => agent.name).filter(Boolean);
    if (!history.length || !names.length) return null;
    const anchor = new Date(data?.last_snapshot_at || history[history.length - 1]?.timestamp || Date.now());
    if (Number.isNaN(anchor.getTime())) return null;
    const cutoff = anchor.getTime() - 24 * 60 * 60 * 1000;
    const rows = history.filter((snap) => {
      const at = new Date(snap?.timestamp || 0).getTime();
      return !Number.isNaN(at) && at >= cutoff && snap?.agents && typeof snap.agents === "object";
    });
    if (!rows.length) return null;
    return {
      labels: rows.map((snap) => snap.timestamp),
      datasets: names.map((name) => ({
        label: name,
        data: rows.map((snap) => {
          const values = snap.agents[name];
          return values && typeof values.total_trued === "number" ? values.total_trued : null;
        }),
      })),
    };
  }

  function renderChart(data) {
    const cumulative = cumulativeSeries(data);
    const labels = cumulative?.labels || data?.chart?.labels || [];
    const datasets = cumulative?.datasets || data?.chart?.datasets ||;
    const hasPoints = labels.length > 0 && datasets.some((set) => set.data.some((n) => n !== null && n !== undefined));
    $("#chart-container").hidden = !hasPoints;
    $("#chart-empty").hidden = hasPoints;
    if (!hasPoints) {
      if (chart) { chart.destroy(); chart = null; }
      $("#chart-legend").innerHTML = "";
      return;
    }
    const rendered = datasets.map((set, i) => ({
      label: set.label,
      data: set.data,
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      pointRadius: 2,
      pointHoverRadius: 4,
      borderWidth: 2,
      spanGaps: false,
      tension: 0.32,
    }));
    const config = {
      type: "line",
      data: { labels, datasets: rendered },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (items) => time(items[0]?.label), label: (item) => `${item.dataset.label}: ${money(item.raw, !cumulative)} $TRUED${cumulative ? " lifetime" : ""}` } },
        },
        scales: {
          x: { ticks: { color: "#7d8f99", maxTicksLimit: 5, maxRotation: 0, callback(value) { return time(this.getLabelForValue(value)); } }, grid: { color: "#1d2932" }, border: { display: false } },
          y: { ticks: { color: "#7d8f99", maxTicksLimit: 5, callback: (value) => Number(value).toLocaleString() }, grid: { color: "#1d2932" }, border: { display: false } },
        },
      },
    };
    if (chart) {
      chart.data = config.data;
      chart.options = config.options;
      chart.update("none");
    } else {
      chart = new Chart($("#earnings-chart"), config);
    }
    $("#chart-legend").innerHTML = rendered.map((set, i) => `<div class="legend-item"><span class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></span>${esc(set.label)}</div>`).join("");
  }

  function renderDashboard(data) {
    dashboard = data;
    $("#last-snapshot").textContent = time(data.last_snapshot_at);
    $("#next-snapshot").textContent = time(data.next_snapshot_at);
    $("#kpi-1h").textContent = data.combined_1h === null ? "—" : money(data.combined_1h);
    $("#kpi-24h").textContent = data.combined_24h === null ? "—" : money(data.combined_24h);
    $("#kpi-1h-foot").textContent = data.combined_1h === null ? "Collecting a one-hour baseline" : `${data.baseline_1h_count} agent${data.baseline_1h_count === 1 ? "" : "s"} · rolling window, falls as gains age out`;
    $("#kpi-24h-foot").textContent = data.combined_24h === null ? "Collecting a 24-hour baseline" : `${data.baseline_24h_count} agent${data.baseline_24h_count === 1 ? "" : "s"} · rolling window, falls as gains age out`;
    $("#kpi-top").textContent = data.top_agent ? data.top_agent.name : "—";
    $("#kpi-top-foot").textContent = data.top_agent ? `${money(data.top_agent.earned_1h)} $TRUED this hour` : "No hourly leader yet";
    $("#kpi-agents").textContent = `${data.matched_count ?? 0}/${data.configured_agent_count ?? 0}`;
    $("#kpi-agents-foot").textContent = "configured names matched in public top 100";
    $("#footer-data").textContent = data.source_total !== null && data.source_total !== undefined ? `Public list: ${count(data.source_total)} agents · ${count(data.history_count)} saved snapshots` : `${count(data.history_count)} saved snapshots`;

    const feedStatus = $("#feed-status");
    if (data.last_error) feedStatus.textContent = "Last source check failed";
    else if (data.last_snapshot_at) feedStatus.textContent = "Saved public snapshot";
    else feedStatus.textContent = "Waiting for public snapshot";
    renderTable(data.agents || []);
    renderChart(data);

    if (data.last_error) {
      setNotice(`${data.last_error} Previously saved history is still available.`, "error");
    } else if (Array.isArray(data.unmatched) && data.unmatched.length) {
      setNotice(`No exact public-label match for: ${data.unmatched.join(", ")}. Dialectica's public endpoint currently returns at most its top 100 agents.`, "info");
    } else if ((data.configured_agent_count || 0) === 0) {
      setNotice("No agents are configured for the public tracker.", "info");
    } else {
      setNotice("");
    }
  }

  async function loadDashboard(showReloadMessage = false) {
    if (loadInProgress) {
      if (showReloadMessage) queuedManualReload = true;
      return;
    }
    loadInProgress = true;
    const button = $("#refresh-button");
    const label = $("#refresh-label");
    button.disabled = true;
    label.textContent = "Loading…";
    $("#refresh-icon").classList.add("spinner");
    let requestTimeout = null;
    const controller = new AbortController();
    try {
      requestTimeout = window.setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Saved dashboard data is unavailable (${response.status})`);
      const previousSnapshotAt = dashboard?.last_snapshot_at ?? null;
      const latest = await response.json();
      renderDashboard(latest);
      if (showReloadMessage && !latest.last_error && !latest.unmatched?.length) {
        const snapshotChanged = latest.last_snapshot_at && latest.last_snapshot_at !== previousSnapshotAt;
        const snapshotTime = time(latest.last_snapshot_at);
        setNotice(snapshotChanged
          ? `New published snapshot loaded (${snapshotTime}).`
          : `You're up to date. Latest snapshot: ${snapshotTime}. Collections are scheduled every 15 minutes; Reload data checks for a published update.`, "info");
        noticeTimer = window.setTimeout(() => {
          noticeTimer = null;
          if (dashboard && !dashboard.last_error && !dashboard.unmatched?.length) setNotice("");
        }, 4500);
      }
    } catch (error) {
      const detail = error?.name === "AbortError" ? "The request timed out. Try again." : (error?.message || "Network error");
      setNotice(`Could not load saved dashboard data: ${detail}`, "error");
      $("#feed-status").textContent = dashboard?.last_snapshot_at ? "Showing saved data · reload failed" : "Dashboard data unavailable";
    } finally {
      if (requestTimeout) window.clearTimeout(requestTimeout);
      loadInProgress = false;
      button.disabled = false;
      label.textContent = "Reload data";
      $("#refresh-icon").classList.remove("spinner");
      if (queuedManualReload) {
        queuedManualReload = false;
        void loadDashboard(true);
      }
    }
  }

  $("#refresh-button").addEventListener("click", () => loadDashboard(true));
  document.querySelectorAll("th button[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (sortKey === key) sortDirection *= -1;
      else { sortKey = key; sortDirection = -1; }
      document.querySelectorAll("th button[data-sort]").forEach((el) => {
        el.classList.toggle("active", el === button);
        const mark = el.querySelector(".sort-mark");
        if (mark) mark.textContent = el === button ? (sortDirection < 0 ? "↓" : "↑") : "";
      });
      if (dashboard) renderTable(dashboard.agents || []);
    });
  });

  loadDashboard();
  window.setInterval(() => loadDashboard(), 15_000);
})();
