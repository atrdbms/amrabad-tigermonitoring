/* Amrabad Tiger Reserve – Tiger Monitoring Management System
 * Static site: reads the published Google Sheet CSV live, then filters,
 * maps on satellite imagery, and builds a printable / exportable report. */
(function () {
  "use strict";
  const CFG = window.ATR_CONFIG;
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const EMPTY_PHOTO = new Set(["", "no", "nil", "na", "n/a", "-", "--", "0", "none", "false", "not available", "without photo", "no photo"]);

  const state = {
    headers: [], rows: [], records: [], col: {}, filtered: [],
    filters: {}, photo: "", search: "", sortKey: null, sortDir: 1,
    pending: {}, pPhoto: "", pSearch: "",
  };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s._\-()/]+/g, "");
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  const uniq = (arr) => [...new Set(arr.filter((v) => v !== "" && v != null))];

  function findColumn(headers, aliases) {
    const map = new Map(headers.map((h) => [norm(h), h]));
    for (const a of aliases) if (map.has(norm(a))) return map.get(norm(a));
    // looser: header starts with alias (e.g. "Latitude (Decimal)")
    for (const a of aliases) {
      const n = norm(a);
      if (n.length < 3) continue;
      const hit = headers.find((h) => norm(h).startsWith(n));
      if (hit) return hit;
    }
    return null;
  }

  function parseCoord(v) {
    if (v == null) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    const neg = /[SW]/i.test(s) || /^-/.test(s);
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums) return NaN;
    let d = parseFloat(nums[0]);
    const isDecimal = /^\s*[NSEW]?\s*-?\d+(?:\.\d+)?\s*°?\s*[NSEW]?\s*$/i.test(s);
    if (!isDecimal && nums.length >= 2) {
      const m = parseFloat(nums[1] || 0), sec = parseFloat(nums[2] || 0);
      if (m < 60 && sec < 60) d = d + m / 60 + sec / 3600;
    }
    return neg ? -d : d;
  }

  function normMonth(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
    if (/^\d{1,2}$/.test(s)) { const n = +s; return n >= 1 && n <= 12 ? MONTHS[n - 1] : s; }
    const hit = MONTHS.find((m) => m.toLowerCase().startsWith(s.toLowerCase().slice(0, 3)));
    return hit || s;
  }

  // Returns {y, m, d} from common Indian / ISO / sheet formats.
  function parseDate(v) {
    const s = String(v ?? "").trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (y < 100) y += 2000;
      // default dd/mm/yyyy; switch if that is impossible
      if (b > 12 && a <= 12) [a, b] = [b, a];
      return { y, m: b, d: a };
    }
    m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-,]*(\d{4})/);
    if (m) { const mi = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[2].toLowerCase().slice(0, 3))); if (mi >= 0) return { y: +m[3], m: mi + 1, d: +m[1] }; }
    const t = Date.parse(s);
    if (!isNaN(t)) { const dt = new Date(t); return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() }; }
    return null;
  }

  function photoLinks(v) {
    const parts = String(v ?? "").split(/[\s,;|]+/).filter((p) => /^https?:\/\//i.test(p));
    return parts.map((url) => {
      const id = (url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/) || [])[1];
      if (id && /google\.com/.test(url)) {
        return { url, thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w800`, big: `https://drive.google.com/thumbnail?id=${id}&sz=w1600`,
                 alt: `https://lh3.googleusercontent.com/d/${id}=w800` };
      }
      return { url, thumb: url, big: url, alt: "" };
    });
  }
  const imgTag = (p, cls, alt = "") => `<img class="pthumb ${cls || ""}" loading="lazy" src="${esc(p.thumb)}" data-alt="${esc(p.alt || "")}" data-big="${esc(p.big)}" data-url="${esc(p.url)}" alt="${esc(alt)}">`;

  // Distinct colours per tiger (no yellow: yellow ring marks "with photo").
  const PALETTE = ["#e6194b","#3cb44b","#4363d8","#f58231","#911eb4","#42d4f4","#f032e6","#9a6324","#469990","#800000","#000075","#bfef45","#fabed4","#dcbeff","#aaffc3","#a9a9a9"];
  const tigerColor = new Map();
  function colorFor(key) {
    if (!tigerColor.has(key)) tigerColor.set(key, PALETTE[tigerColor.size % PALETTE.length]);
    return tigerColor.get(key);
  }

  // ---------- load ----------
  function load() {
    setStatus("Loading data from Google Sheet…");
    const url = CFG.csvUrl + (CFG.csvUrl.includes("?") ? "&" : "?") + "_=" + Date.now();
    Papa.parse(url, {
      download: true, header: true, skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        if (!res.data || !res.data.length) { setStatus("The sheet returned no rows.", true); return; }
        ingest(res.meta.fields.filter((f) => f !== ""), res.data);
      },
      error: (err) => setStatus("Could not load the sheet: " + err + ". Check that it is still published to the web.", true),
    });
  }

  function ingest(headers, rows) {
    state.headers = headers;
    state.rawRows = rows;
    const col = {};
    for (const [k, aliases] of Object.entries(CFG.columns)) col[k] = findColumn(headers, aliases);
    // Combined "lat, long" column fallback
    if (!col.lat || !col.lon) {
      const combo = findColumn(headers, ["Lat Long", "LatLong", "Coordinates", "GPS", "Location", "GPS Location"]);
      if (combo) col.combo = combo;
    }
    state.col = col;

    state.records = rows.map((r, i) => {
      const g = (k) => (col[k] ? String(r[col[k]] ?? "").trim() : "");
      const dt = parseDate(g("date"));
      let year = g("year"), month = normMonth(g("month"));
      if (!year && dt) year = String(dt.y);
      if (!month && dt) month = MONTHS[dt.m - 1];
      let lat = parseCoord(g("lat")), lon = parseCoord(g("lon"));
      if ((isNaN(lat) || isNaN(lon)) && col.combo) {
        const p = String(r[col.combo] || "").split(/[,;]|\s{2,}/);
        if (p.length >= 2) { lat = parseCoord(p[0]); lon = parseCoord(p[1]); }
      }
      // swapped lat/long safeguard for India (lat ~8–37, lon ~68–97)
      if (lat > 60 && lon < 40) [lat, lon] = [lon, lat];
      const rawPhoto = g("photo");
      const photos = photoLinks(rawPhoto);
      const photoName = g("photoName");
      const hasPhoto = photos.length > 0 || !EMPTY_PHOTO.has(rawPhoto.toLowerCase()) || !EMPTY_PHOTO.has(photoName.toLowerCase());
      const tid = g("tigerId");
      const sx = (tid.match(/(?:^|[\s_\-])([MF])(?=[\s_\-]*\d)/i) || [])[1];
      const sex = sx ? (sx.toUpperCase() === "M" ? "Male" : "Female") : "";
      const monthIdx = MONTHS.indexOf(month);
      const sortKey = dt ? dt.y * 10000 + dt.m * 100 + dt.d : (parseInt(year) || 0) * 10000 + (monthIdx + 1) * 100;
      const fields = {
        year, month, tigerId: g("tigerId"), division: g("division"), range: g("range"),
        section: g("section"), beat: g("beat"), block: g("block"), compt: g("compt"),
      };
      const search = Object.values(r).join(" ").toLowerCase();
      return { i, raw: r, ...fields, sex, evidence: g("evidence"), photoName, lat, lon, hasCoord: isFinite(lat) && isFinite(lon) && lat !== 0 && lon !== 0, photos, hasPhoto, sortKey, dateText: g("date"), search };
    });

    tigerColor.clear(); uniq(state.records.map((r) => r.tigerId)).sort(natural).forEach(colorFor);
    buildFilterFields();
    setupBuilders();
    applyFilters(true);
    const missing = CFG.filterOrder.filter((k) => !col[k]).map((k) => CFG.labels[k]);
    if (!col.lat || !col.lon) if (!col.combo) missing.push("Latitude/Longitude");
    if (!col.photo) missing.push("Photo");
    const ts = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    setStatus(`● Live · ${state.records.length} records · synced ${ts}`, false);
    showBanner(missing.length ? `Some columns were not found in the sheet: <b>${esc(missing.join(", "))}</b>. Add their header names in config.js → columns.` : "");
  }

  function setStatus(msg, warn) { const el = $("#status"); el.textContent = msg; el.classList.toggle("warn", !!warn); if (warn) showBanner(esc(msg)); }
  function showBanner(html) {
    let b = $("#banner");
    if (!b) { b = document.createElement("div"); b.id = "banner"; b.className = "banner no-print"; $(".content").prepend(b); }
    b.innerHTML = html; b.hidden = !html;
  }


  // ---------- filter panel (M-STrIPES style: choose, then Apply) ----------
  function buildFilterFields() {
    const host = $("#filterFields"); host.innerHTML = "";
    CFG.filterOrder.forEach((k) => {
      host.insertAdjacentHTML("beforeend", `
        <div class="field" ${state.col[k] ? "" : 'data-missing="1" title="Column not found in sheet"'}>
          <label for="f_${k}">${esc(CFG.labels[k])}</label>
          <select id="f_${k}" data-key="${k}"><option value="">-- All --</option></select>
        </div>`);
    });
    document.querySelectorAll("#filterFields select").forEach((sel) => sel.addEventListener("change", () => {
      state.pending[sel.dataset.key] = sel.value;
      refreshOptions(); markDirty();
    }));
  }

  function matches(r, skipKey, f = state.filters, photo = state.photo, search = state.search) {
    for (const k of CFG.filterOrder) {
      if (k === skipKey) continue;
      if (f[k] && r[k] !== f[k]) return false;
    }
    if (photo === "with" && !r.hasPhoto) return false;
    if (photo === "without" && r.hasPhoto) return false;
    if (search && !r.search.includes(search)) return false;
    return true;
  }

  // Options cascade from the pending (not yet applied) selection.
  function refreshOptions() {
    for (const k of CFG.filterOrder) {
      const sel = $("#f_" + k);
      if (!sel) continue;
      const pool = state.records.filter((r) => matches(r, k, state.pending, state.pPhoto, state.pSearch));
      const vals = uniq(pool.map((r) => r[k]));
      vals.sort(k === "month" ? (a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b) : k === "year" ? (a, b) => natural(b, a) : natural);
      const cur = state.pending[k] || "";
      if (cur && !vals.includes(cur)) vals.unshift(cur);
      const counts = {}; pool.forEach((r) => { counts[r[k]] = (counts[r[k]] || 0) + 1; });
      sel.innerHTML = `<option value="">All (${vals.length})</option>` +
        vals.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)} (${counts[v] || 0})</option>`).join("");
      sel.classList.toggle("set", !!cur);
    }
  }

  function markDirty() {
    const dirty = JSON.stringify(state.pending) !== JSON.stringify(state.filters) || state.pPhoto !== state.photo || state.pSearch !== state.search;
    $("#applyBtn").classList.toggle("pulse", dirty);
  }

  function commitFilters() {
    state.filters = { ...state.pending }; state.photo = state.pPhoto; state.search = state.pSearch;
    applyFilters(true); markDirty();
  }

  function applyFilters(fit) {
    state.filtered = state.records.filter((r) => matches(r)).sort((a, b) => a.sortKey - b.sortKey || a.i - b.i);
    refreshOptions();
    renderApplied();
    renderKpis();
    renderCharts();
    renderLatest();
    renderMaps(fit);
    renderProfiles();
    renderReport();
    renderCustom();
    renderPivot();
    renderRecords();
  }

  function filterParts() {
    const parts = CFG.filterOrder.filter((k) => state.filters[k]).map((k) => [CFG.labels[k], state.filters[k]]);
    if (state.photo) parts.push(["Photo", state.photo === "with" ? "With photo" : "Without photo"]);
    if (state.search) parts.push(["Search", state.search]);
    return parts;
  }
  function filterSummary() {
    const p = filterParts();
    return p.length ? p.map(([a, b]) => `${a}: ${b}`).join(" · ") : "All records (no filters)";
  }
  function renderApplied() {
    const p = filterParts();
    const html = p.length ? p.map(([a, b]) => `<span class="chip"><small>${esc(a)}</small> ${esc(b)}</span>`).join("") : `<span class="muted">No filters applied – showing all records.</span>`;
    $("#applied").innerHTML = `<b>Applied:</b> ${html}`;
    const crumb = `Showing <b>${state.filtered.length}</b> of ${state.records.length} records · ${esc(filterSummary())}`;
    $("#crumb1").innerHTML = crumb; $("#crumb2").innerHTML = crumb;
  }

  function kpiData() {
    const f = state.filtered;
    return [
      ["Total Records", f.length, "📍", "c1"],
      ["Individual Tigers", ids(f).length, "🐅", "c2"],
      ["Males", ids(f.filter((r) => r.sex === "Male")).length, "♂", "c5"],
      ["Females", ids(f.filter((r) => r.sex === "Female")).length, "♀", "c7"],
      ["With Photo", f.filter((r) => r.hasPhoto).length, "📷", "c3"],
      ["Without Photo", f.filter((r) => !r.hasPhoto).length, "🚫", "c4"],
      ["Ranges Covered", uniq(f.map((r) => r.range)).length, "🗺", "c8"],
      ["Beats Covered", uniq(f.map((r) => r.beat)).length, "🌲", "c6"],
    ];
  }
  function renderKpis() {
    $("#kpis").innerHTML = kpiData().map(([l, v, ic, c]) => `<div class="kpi ${c}"><div class="kpi-ic">${ic}</div><div><b>${v}</b><span>${l}</span></div></div>`).join("");
  }

  // ---------- charts ----------
  const charts = {};
  const C = { green: "#2e7d32", orange: "#ef8a17", teal: "#00796b", grid: "#e6e9e1", ink: "#44503f" };
  function chart(id, cfg) {
    if (!window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }
  function baseOpts(extra = {}) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      plugins: { legend: { display: false, labels: { color: C.ink, boxWidth: 12 } }, tooltip: { backgroundColor: "#1b2f17" } },
      scales: {
        x: { grid: { display: false }, ticks: { color: C.ink } },
        y: { beginAtZero: true, grid: { color: C.grid }, ticks: { color: C.ink, precision: 0 } },
      },
    }, extra);
  }
  function renderCharts() {
    const f = state.filtered;
    // month-wise
    const ym = new Map();
    f.forEach((r) => { const k = (r.year || "") + "|" + (r.month || ""); ym.set(k, (ym.get(k) || 0) + 1); });
    const yk = [...ym.keys()].sort((a, b) => { const [ya, ma] = a.split("|"), [yb, mb] = b.split("|"); return natural(ya, yb) || MONTHS.indexOf(ma) - MONTHS.indexOf(mb); });
    chart("chMonth", { type: "bar", data: { labels: yk.map((k) => { const [y, m] = k.split("|"); return (m ? m.slice(0, 3) : "–") + " " + (y || ""); }),
      datasets: [{ label: "Records", data: yk.map((k) => ym.get(k)), backgroundColor: C.green, borderRadius: 4, maxBarThickness: 38 }] }, options: baseOpts() });
    // year-wise
    const yg = group(f, (r) => r.year || "–"); const yks = [...yg.keys()].sort(natural);
    chart("chYear", { type: "bar", data: { labels: yks, datasets: [
      { label: "Records", data: yks.map((k) => yg.get(k).length), backgroundColor: C.green, borderRadius: 4, maxBarThickness: 46, yAxisID: "y" },
      { label: "Individual tigers", data: yks.map((k) => ids(yg.get(k)).length), backgroundColor: C.orange, borderRadius: 4, maxBarThickness: 46, yAxisID: "y" },
    ] }, options: baseOpts({ plugins: { legend: { display: true, position: "top", align: "end", labels: { color: C.ink, boxWidth: 12 } } } }) });
    // evidence / sex doughnuts
    const eg = group(f, (r) => r.evidence || "Not recorded"); const eks = [...eg.keys()].sort((a, b) => eg.get(b).length - eg.get(a).length);
    const dcol = ["#2e7d32", "#ef8a17", "#00796b", "#8d6e63", "#3f51b5", "#c0ca33", "#ad1457", "#90a4ae"];
    chart("chEvid", { type: "doughnut", data: { labels: eks, datasets: [{ data: eks.map((k) => eg.get(k).length), backgroundColor: dcol, borderColor: "#fff", borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right", labels: { color: C.ink, boxWidth: 12 } } } } });
    const males = ids(f.filter((r) => r.sex === "Male")).length, females = ids(f.filter((r) => r.sex === "Female")).length, unk = ids(f.filter((r) => !r.sex)).length;
    chart("chSex", { type: "doughnut", data: { labels: ["Male", "Female", "Unknown"], datasets: [{ data: [males, females, unk], backgroundColor: ["#1e88e5", "#d81b60", "#b0bec5"], borderColor: "#fff", borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right", labels: { color: C.ink, boxWidth: 12 } } } } });
    // range-wise
    const rg = group(f, (r) => r.range || "(blank)");
    const rk = [...rg.keys()].sort(natural);
    chart("chRange", { type: "bar", data: { labels: rk, datasets: [
      { label: "Records", data: rk.map((k) => rg.get(k).length), backgroundColor: C.green, borderRadius: 4, maxBarThickness: 34 },
      { label: "Individual tigers", data: rk.map((k) => ids(rg.get(k)).length), backgroundColor: C.orange, borderRadius: 4, maxBarThickness: 34 },
    ] }, options: baseOpts({ plugins: { legend: { display: true, position: "top", align: "end", labels: { color: C.ink, boxWidth: 12 } } } }) });
    // per tiger
    const tg = group(f, (r) => r.tigerId || "(blank)");
    const tk = [...tg.keys()].sort((a, b) => tg.get(b).length - tg.get(a).length || natural(a, b)).slice(0, 25);
    chart("chTiger", { type: "bar", data: { labels: tk, datasets: [
      { label: "With photo", data: tk.map((k) => tg.get(k).filter((r) => r.hasPhoto).length), backgroundColor: C.teal, maxBarThickness: 22 },
      { label: "Without photo", data: tk.map((k) => tg.get(k).filter((r) => !r.hasPhoto).length), backgroundColor: "#b9c4b2", maxBarThickness: 22 },
    ] }, options: baseOpts({ indexAxis: "y",
      plugins: { legend: { display: true, position: "top", align: "end", labels: { color: C.ink, boxWidth: 12 } } },
      scales: { x: { stacked: true, beginAtZero: true, grid: { color: C.grid }, ticks: { precision: 0, color: C.ink } }, y: { stacked: true, grid: { display: false }, ticks: { color: C.ink, autoSkip: false, font: { size: 11 } } } } }) });
  }

  function renderLatest() {
    const list = state.filtered.slice(-10).reverse();
    $("#latest").innerHTML = list.length ? `<table class="data"><thead><tr><th>Date / Period</th><th>Tiger ID</th><th>Range</th><th>Section</th><th>Beat</th><th>Compt</th><th>Photo</th></tr></thead><tbody>${
      list.map((r) => `<tr data-i="${r.i}" class="go"><td>${esc(r.dateText || period(r))}</td><td><span class="tid" style="--c:${colorFor(r.tigerId)}">${esc(r.tigerId)}</span></td><td>${esc(r.range)}</td><td>${esc(r.section)}</td><td>${esc(r.beat)}</td><td>${esc(r.compt)}</td><td>${r.hasPhoto ? '<span class="badge ok">Yes</span>' : '<span class="badge no">No</span>'}</td></tr>`).join("")}</tbody></table>` : `<p class="muted pad">No records for this selection.</p>`;
  }

  // ---------- maps ----------
  let map, cluster, pathLayer, showPaths = false, mini, miniLayer;
  function baseLayers() {
    return {
      "Google Satellite (labels)": L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", { subdomains: "0123", maxZoom: 21, attribution: "Imagery © Google" }),
      "Google Satellite": L.tileLayer("https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", { subdomains: "0123", maxZoom: 21, attribution: "Imagery © Google" }),
      "Google Terrain": L.tileLayer("https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}", { subdomains: "0123", maxZoom: 21, attribution: "Map © Google" }),
      "Esri World Imagery": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" }),
      "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
    };
  }
  function initMaps() {
    map = L.map("map").setView(CFG.mapCenter, CFG.mapZoom);
    const bl = baseLayers(); bl["Google Satellite (labels)"].addTo(map);
    L.control.layers(bl).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    const FS = L.Control.extend({ onAdd() {
      const b = L.DomUtil.create("a", "leaflet-bar fs-btn");
      b.href = "#"; b.id = "fsBtn"; b.title = "Full screen (Esc to exit)"; b.innerHTML = "⛶ <span>Full screen</span>";
      L.DomEvent.on(b, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); toggleMapFull(); });
      return b;
    } });
    map.addControl(new FS({ position: "topright" }));
    cluster = L.markerClusterGroup({ maxClusterRadius: 35, disableClusteringAtZoom: 15 });
    map.addLayer(cluster);
    pathLayer = L.layerGroup().addTo(map);
    const Ctl = L.Control.extend({ onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar map-toggle");
      d.innerHTML = `<b>Map options</b><label><input type="checkbox" id="pathToggle"> Movement lines per tiger</label><label><input type="checkbox" id="clusterToggle" checked> Group nearby points</label>`;
      L.DomEvent.disableClickPropagation(d); return d;
    } });
    map.addControl(new Ctl({ position: "topleft" }));
    $("#pathToggle").addEventListener("change", (e) => { showPaths = e.target.checked; renderMaps(false); });
    $("#clusterToggle").addEventListener("change", (e) => { cluster.options.disableClusteringAtZoom = e.target.checked ? 15 : 1; renderMaps(false); });

    // legend: show / hide tigers
    $("#mapNote").addEventListener("change", (e) => {
      const t = e.target.dataset.tg; if (t === undefined) return;
      e.target.checked ? state.hiddenTigers.delete(t) : state.hiddenTigers.add(t); renderMaps(false);
    });
    $("#mapNote").addEventListener("click", (e) => {
      const a = e.target.dataset.lg; if (!a) return;
      const all = uniq(state.filtered.filter((r) => r.hasCoord).map((r) => r.tigerId));
      if (a === "all") state.hiddenTigers.clear();
      if (a === "none") all.forEach((t) => state.hiddenTigers.add(t));
      if (a === "toggle") $("#mapNote").classList.toggle("collapsed");
      renderMaps(false);
    });
    L.DomEvent.disableClickPropagation($("#mapNote")); L.DomEvent.disableScrollPropagation($("#mapNote"));
    initKml();

    mini = L.map("miniMap", { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(CFG.mapCenter, CFG.mapZoom);
    baseLayers()["Google Satellite (labels)"].addTo(mini);
    miniLayer = L.layerGroup().addTo(mini);
  }

  // ---------- full-screen map ----------
  function setMapFull(on) {
    const v = $("#view-map");
    v.classList.toggle("map-full", on);
    document.body.classList.toggle("no-scroll", on);
    $("#fsBtn").innerHTML = on ? "✕ <span>Exit full screen</span>" : "⛶ <span>Full screen</span>";
    $("#fsBtn").title = on ? "Exit full screen (Esc)" : "Full screen (Esc to exit)";
    setTimeout(() => map.invalidateSize(), 120);
  }
  function toggleMapFull() {
    const v = $("#view-map"), on = !v.classList.contains("map-full");
    setMapFull(on);
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && $("#view-map").classList.contains("map-full")) setMapFull(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#view-map").classList.contains("map-full") && !document.fullscreenElement) setMapFull(false); });

  function marker(r) {
    const m = r.hasPhoto
      ? L.marker([r.lat, r.lon], { icon: L.divIcon({ className: "cam-pin", html: `<div style="--c:${colorFor(r.tigerId)}"><span>📷</span></div>`, iconSize: [30, 38], iconAnchor: [15, 36], popupAnchor: [0, -32] }) })
      : L.circleMarker([r.lat, r.lon], { radius: 7, weight: 2, color: "#fff", fillColor: colorFor(r.tigerId), fillOpacity: 0.95 });
    m.bindPopup(() => popupHtml(r), { maxWidth: 380, minWidth: 300 });
    m.bindTooltip(esc(r.tigerId || "Unknown") + (r.month ? " · " + esc(r.month) + " " + esc(r.year) : "") + (r.hasPhoto ? " · 📷 click to view photo" : ""));
    return m;
  }

  function popupHtml(r) {
    const skip = new Set([state.col.photo, state.col.photoName, state.col.lat, state.col.lon].filter(Boolean));
    const rows = state.headers.filter((h) => !skip.has(h) && String(r.raw[h] ?? "").trim() !== "")
      .map((h) => `<tr><th>${esc(h)}</th><td>${esc(r.raw[h])}</td></tr>`).join("");
    const pics = r.photos.map((p) => imgTag(p, "pop-img", "Photo of " + r.tigerId)).join("");
    const nameTxt = r.photoName ? `<div class="pcap">${esc(r.photoName.split("/").pop())} · click photo to enlarge</div>` : `<div class="pcap">Click photo to enlarge</div>`;
    const photoBlock = pics ? `<div class="pgal">${pics}</div>${nameTxt}`
      : `<div class="nophoto">${r.hasPhoto ? "📷 Photo recorded: " + esc(r.photoName || r.raw[state.col.photo] || "") + " (no link in photo_URL)" : "No photo for this record"}</div>`;
    return `<div class="popup">
      <div class="pop-h" style="--c:${colorFor(r.tigerId)}">${esc(r.tigerId || "Unknown tiger")}<small>${esc(r.dateText || period(r))}</small></div>
      <div class="coords">${r.lat.toFixed(5)}° N, ${r.lon.toFixed(5)}° E · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${r.lat},${r.lon}&t=k">Google Maps ↗</a></div>
      ${photoBlock}
      <div class="pop-act"><button class="btn sm" data-edit="${r.i}">✏ Edit details</button><button class="btn sm" data-edit="${r.i}" data-photo="1">📷 Add photo</button></div>
      <table>${rows}</table></div>`;
  }

  function renderMaps(fit) {
    if (!map) return;
    cluster.clearLayers(); pathLayer.clearLayers(); miniLayer.clearLayers();
    const allPts = state.filtered.filter((r) => r.hasCoord);
    const hidden = state.hiddenTigers || (state.hiddenTigers = new Set());
    const pts = allPts.filter((r) => !hidden.has(r.tigerId));
    cluster.addLayers(pts.map(marker));
    pts.forEach((r) => marker(r).addTo(miniLayer));
    if (showPaths) {
      const by = group(pts, (r) => r.tigerId);
      by.forEach((list, id) => {
        if (list.length < 2) return;
        L.polyline(list.map((r) => [r.lat, r.lon]), { color: colorFor(id), weight: 2.5, opacity: 0.9, dashArray: "6 5" }).bindTooltip(esc(id)).addTo(pathLayer);
      });
    }
    if (fit && pts.length) {
      const b = L.latLngBounds(pts.map((r) => [r.lat, r.lon])).pad(0.15);
      state.lastBounds = b;
      if (map.getSize().x > 0) map.fitBounds(b, { maxZoom: 15 }); else state.fitMain = true;
      if (mini.getSize().x > 0) mini.fitBounds(b, { maxZoom: 14 }); else state.fitMini = true;
    }
    const noCoord = state.filtered.length - allPts.length;
    const byT = group(allPts, (r) => r.tigerId);
    const tigers = [...byT.keys()].sort(natural);
    const shown = tigers.filter((t) => !hidden.has(t)).length;
    const collapsed = $("#mapNote").classList.contains("collapsed");
    $("#mapNote").innerHTML = `<div class="lg-title"><span>Legend · Tiger ID <small>(${shown}/${tigers.length} shown)</small></span><button class="lg-col" data-lg="toggle" title="Collapse">${collapsed ? "▲" : "▼"}</button></div>
      <div class="lg-body">
        <div class="lg-btns"><button data-lg="all">Select all</button><button data-lg="none">Clear all</button></div>
        <div class="lg-list">${tigers.map((t) => `<label class="lg-item"><input type="checkbox" data-tg="${esc(t)}" ${hidden.has(t) ? "" : "checked"}><i class="lg" style="background:${colorFor(t)}"></i><span>${esc(t || "(no ID)")}</span><small>${byT.get(t).length}</small></label>`).join("")}</div>
        <div class="lg-foot"><span><i class="cam-mini">📷</i>With photo</span><span><i class="lg" style="background:#888"></i>No photo</span></div>
        ${noCoord ? `<div class="warn">${noCoord} record(s) without valid Lat/Long</div>` : ""}
      </div>`;
  }

  // ---------- KML / KMZ overlays ----------
  const KML_COLORS = ["#ffeb3b", "#00e5ff", "#ff4081", "#76ff03", "#ff9100", "#e040fb", "#ffffff"];
  const kmlLayers = []; // {id, name, layer, color, on}
  function kmlColor(c) { // KML aabbggrr → #rrggbb
    const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((c || "").trim());
    return m ? `#${m[4]}${m[3]}${m[2]}` : null;
  }
  function parseCoordsText(t) {
    return (t || "").trim().split(/\s+/).map((x) => x.split(",").map(Number)).filter((a) => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map((a) => [a[1], a[0]]);
  }
  function kmlToLayer(text, color) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("This file is not valid KML.");
    const styles = {};
    [...doc.getElementsByTagName("Style")].forEach((st) => {
      const id = st.getAttribute("id"); if (!id) return;
      const lc = st.querySelector("LineStyle > color"), pc = st.querySelector("PolyStyle > color");
      styles["#" + id] = { line: lc && kmlColor(lc.textContent), poly: pc && kmlColor(pc.textContent) };
    });
    [...doc.getElementsByTagName("StyleMap")].forEach((sm) => {
      const id = sm.getAttribute("id"); const n = [...sm.getElementsByTagName("Pair")].find((p) => (p.querySelector("key") || {}).textContent === "normal");
      const u = n && n.querySelector("styleUrl"); if (id && u && styles[u.textContent.trim()]) styles["#" + id] = styles[u.textContent.trim()];
    });
    const fg = L.featureGroup(); let count = 0;
    [...doc.getElementsByTagName("Placemark")].forEach((pm) => {
      const name = (pm.querySelector("name") || {}).textContent || "";
      const descEl = pm.querySelector("description");
      const data = [...pm.querySelectorAll("ExtendedData Data, ExtendedData SimpleData")].map((d) => [d.getAttribute("name"), (d.querySelector("value") || d).textContent.trim()]).filter((x) => x[1]);
      const su = (pm.querySelector("styleUrl") || {}).textContent; const st = (su && styles[su.trim()]) || {};
      const lineCol = st.line || color, fillCol = st.poly || color;
      const popup = `<div class="popup"><div class="pop-h" style="--c:${lineCol}">${esc(name || "Feature")}</div>` +
        (data.length ? `<table>${data.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>` : "") +
        (descEl && !data.length ? `<div class="kdesc">${esc(descEl.textContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 600)}</div>` : "") + `</div>`;
      const add = (ly) => { ly.bindPopup(popup, { maxWidth: 340 }); if (name) ly.bindTooltip(esc(name), { sticky: true }); fg.addLayer(ly); count++; };
      [...pm.getElementsByTagName("Polygon")].forEach((pg) => {
        const outer = parseCoordsText((pg.querySelector("outerBoundaryIs coordinates") || {}).textContent);
        const inner = [...pg.querySelectorAll("innerBoundaryIs coordinates")].map((c) => parseCoordsText(c.textContent));
        if (outer.length > 2) add(L.polygon([outer, ...inner], { color: lineCol, weight: 2.5, fillColor: fillCol, fillOpacity: 0.08 }));
      });
      [...pm.getElementsByTagName("LineString")].forEach((ls) => {
        const c = parseCoordsText((ls.querySelector("coordinates") || {}).textContent);
        if (c.length > 1) add(L.polyline(c, { color: lineCol, weight: 2.5 }));
      });
      [...pm.getElementsByTagName("Point")].forEach((pt) => {
        const c = parseCoordsText((pt.querySelector("coordinates") || {}).textContent)[0];
        if (c) add(L.circleMarker(c, { radius: 5, color: "#000", weight: 1, fillColor: lineCol, fillOpacity: 1 }));
      });
    });
    if (!count) throw new Error("No polygons, lines or points were found in this file.");
    return { layer: fg, count };
  }
  async function readKmlFile(file) {
    if (/\.kmz$/i.test(file.name)) {
      if (!window.JSZip) throw new Error("KMZ support could not load. Try a .kml file.");
      const zip = await JSZip.loadAsync(file);
      const kml = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
      if (!kml) throw new Error("No .kml file inside this KMZ.");
      return kml.async("string");
    }
    return file.text();
  }
  function addKml(name, text, opts = {}) {
    const color = KML_COLORS[kmlLayers.length % KML_COLORS.length];
    const { layer, count } = kmlToLayer(text, color);
    const item = { id: "k" + Date.now() + Math.random().toString(36).slice(2, 6), name, layer, color, count, on: true, fixed: !!opts.fixed };
    layer.addTo(map); kmlLayers.push(item);
    if (!opts.noZoom) map.fitBounds(layer.getBounds(), { maxZoom: 15 });
    if (!opts.fixed && !opts.restored) { try { const saved = JSON.parse(localStorage.getItem("atr_kml") || "[]"); saved.push({ name, text }); localStorage.setItem("atr_kml", JSON.stringify(saved)); } catch (e) { /* too large to remember */ } }
    renderKmlList();
  }
  function renderKmlList() {
    $("#kmlList").innerHTML = kmlLayers.length ? kmlLayers.map((k) => `<div class="kml-item">
        <label><input type="checkbox" data-kon="${k.id}" ${k.on ? "checked" : ""}><i class="lg" style="background:${k.color}"></i><span title="${esc(k.name)}">${esc(k.name)}</span></label>
        <small>${k.count}</small><button data-kzoom="${k.id}" title="Zoom to layer">⌖</button>${k.fixed ? "" : `<button data-kdel="${k.id}" title="Remove layer">✕</button>`}</div>`).join("")
      : `<div class="muted small">No boundary layers yet.</div>`;
  }
  function initKml() {
    const Ctl = L.Control.extend({ onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar map-toggle kml-ctl");
      d.innerHTML = `<b>Boundary layers (KML)</b>
        <label class="btn sm kml-up">📂 Upload KML / KMZ<input type="file" id="kmlFile" accept=".kml,.kmz" multiple hidden></label>
        <div id="kmlList"></div><div id="kmlMsg" class="small"></div>`;
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d;
    } });
    map.addControl(new Ctl({ position: "topleft" }));
    renderKmlList();
    $("#kmlFile").addEventListener("change", async (e) => {
      for (const f of e.target.files) {
        try { addKml(f.name.replace(/\.(kml|kmz)$/i, ""), await readKmlFile(f)); $("#kmlMsg").textContent = ""; }
        catch (err) { $("#kmlMsg").textContent = `${f.name}: ${err.message}`; }
      }
      e.target.value = "";
    });
    $("#kmlList").addEventListener("change", (e) => {
      const k = kmlLayers.find((x) => x.id === e.target.dataset.kon); if (!k) return;
      k.on = e.target.checked; k.on ? k.layer.addTo(map) : map.removeLayer(k.layer);
    });
    $("#kmlList").addEventListener("click", (e) => {
      const z = kmlLayers.find((x) => x.id === e.target.dataset.kzoom);
      if (z) { if (!z.on) { z.on = true; z.layer.addTo(map); renderKmlList(); } map.fitBounds(z.layer.getBounds(), { maxZoom: 15 }); return; }
      const i = kmlLayers.findIndex((x) => x.id === e.target.dataset.kdel);
      if (i >= 0) {
        const [k] = kmlLayers.splice(i, 1); map.removeLayer(k.layer);
        try { const saved = JSON.parse(localStorage.getItem("atr_kml") || "[]").filter((x) => x.name !== k.name); localStorage.setItem("atr_kml", JSON.stringify(saved)); } catch (er) { /* ignore */ }
        renderKmlList();
      }
    });
    // layers shipped with the site (config.js → kmlLayers), then ones uploaded earlier in this browser
    (CFG.kmlLayers || []).forEach((k) => fetch(k.url).then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((t) => addKml(k.name, t, { fixed: true, noZoom: true })).catch(() => { $("#kmlMsg").textContent = `Could not load ${k.url}`; }));
    try { JSON.parse(localStorage.getItem("atr_kml") || "[]").forEach((k) => addKml(k.name, k.text, { restored: true, noZoom: true })); } catch (e) { /* ignore */ }
  }

  // ---------- edit records & add photos (via Google Apps Script) ----------
  const EDIT_LIST_FIELDS = ["tigerId", "evidence", "division", "range", "section", "beat", "block"];
  let emRec = null, emPhoto = null;
  function openEditor(r, focusPhoto) {
    emRec = r; emPhoto = null;
    const H = state.headers, col = state.col;
    const keyCol = H.find((h) => /^(sl_?no|s\.?\s?no|serial)/i.test(h)) || H[0];
    state.keyCol = keyCol;
    const skip = new Set([col.photo, col.photoName].filter(Boolean));
    $("#emTitle").textContent = r ? `Edit record ${r.raw[keyCol] ? "#" + r.raw[keyCol] : ""} – ${r.tigerId || ""}` : "Add new record";
    const listOf = {}; EDIT_LIST_FIELDS.forEach((k) => { if (col[k]) listOf[col[k]] = uniq(state.records.map((x) => x[k])).sort(natural); });
    $("#emFields").innerHTML = H.filter((h) => !skip.has(h)).map((h) => {
      const v = r ? r.raw[h] ?? "" : "";
      const ro = h === keyCol;
      const dl = listOf[h] ? `<datalist id="dl_${esc(norm(h))}">${listOf[h].map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : "";
      const ph = h === col.date ? "dd/mm/yyyy" : h === col.lat ? "e.g. 16.26149" : h === col.lon ? "e.g. 78.62613" : "";
      const wide = /remark|location/i.test(h) ? " wide" : "";
      return `<label class="em-f${wide}">${esc(h)}<input data-h="${esc(h)}" value="${esc(ro && !r ? "(auto)" : v)}" ${ro ? "readonly" : ""} placeholder="${ph}" ${dl ? `list="dl_${esc(norm(h))}"` : ""}>${dl}</label>`;
    }).join("");
    const cur = r ? r.photos : [];
    $("#emPhPrev").innerHTML = cur.length ? cur.map((p) => imgTag(p, "")).join("") : `<span>No photo yet</span>`;
    $("#emFile").value = ""; $("#emFileInfo").textContent = "The photo is saved to Google Drive and linked in the photo_URL column.";
    $("#emKeep").closest("label").hidden = !cur.length;
    $("#emPass").value = sessionStorage.getItem("atr_edit_pw") || "";
    $("#emMsg").textContent = ""; $("#emMsg").className = "small";
    const setup = !CFG.editApiUrl;
    $("#emSetup").hidden = !setup;
    $("#emSetup").innerHTML = setup ? "Saving is not switched on yet. Follow the one-time setup in README → <b>Editing records &amp; adding photos</b>, then put the web-app link in <code>config.js → editApiUrl</code>." : "";
    $("#emSave").disabled = setup;
    $("#editModal").hidden = false;
    if (focusPhoto) $("#emFile").closest(".em-photo").scrollIntoView({ block: "center" });
  }
  function autoDateParts(e) {
    const c = state.col; if (e.target.dataset.h !== c.date) return;
    const d = parseDate(e.target.value); if (!d) return;
    const set = (h, v) => { const i = h && $(`#emFields input[data-h="${CSS.escape(h)}"]`); if (i && !i.readOnly) i.value = v; };
    set(c.year, d.y); set(c.month, MONTHS[d.m - 1]);
    const mc = state.headers.find((h) => /^month_?code$/i.test(h)); set(mc, d.m);
  }
  async function saveEditor(ev) {
    ev.preventDefault();
    const msg = $("#emMsg");
    const values = {};
    document.querySelectorAll("#emFields input[data-h]").forEach((i) => {
      if (i.readOnly) return;
      const h = i.dataset.h, v = i.value.trim();
      if (!emRec || String(emRec.raw[h] ?? "").trim() !== v) values[h] = v;
    });
    const lat = parseFloat(values[state.col.lat] ?? (emRec ? emRec.raw[state.col.lat] : ""));
    const lon = parseFloat(values[state.col.lon] ?? (emRec ? emRec.raw[state.col.lon] : ""));
    if ((values[state.col.lat] || values[state.col.lon]) && !(lat > 8 && lat < 38 && lon > 68 && lon < 98)) { msg.textContent = "Latitude/Longitude look wrong (expect about 16.x and 78.x)."; msg.className = "small err"; return; }
    if (!Object.keys(values).length && !emPhoto) { msg.textContent = "Nothing changed."; return; }
    const pw = $("#emPass").value;
    const body = { action: emRec ? "update" : "add", key: emRec ? emRec.raw[state.keyCol] : "", values, password: pw, keepOldPhotos: $("#emKeep").checked };
    if (emPhoto) body.photo = { data: emPhoto.split(",")[1], mime: "image/jpeg" };
    $("#emSave").disabled = true; msg.className = "small"; msg.textContent = emPhoto ? "Uploading photo and saving…" : "Saving…";
    try {
      const res = await fetch(CFG.editApiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "Save failed");
      sessionStorage.setItem("atr_edit_pw", pw);
      // apply locally so the change shows at once (the published sheet link refreshes within a few minutes)
      const saved = Object.assign({}, out.values || values);
      if (emRec) Object.assign(state.rawRows[emRec.i], saved);
      else state.rawRows.push(Object.assign(Object.fromEntries(state.headers.map((h) => [h, ""])), saved, { [state.keyCol]: out.key }));
      ingest(state.headers, state.rawRows);
      $("#editModal").hidden = true;
      toast(emRec ? `Record #${out.key} saved to the sheet.` : `New record #${out.key} added to the sheet.`);
    } catch (err) {
      msg.textContent = "Not saved: " + err.message; msg.className = "small err";
    } finally { $("#emSave").disabled = false; }
  }
  function toast(t) { const el = $("#toast"); el.textContent = "✔ " + t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 5000); }
  function wireEditor() {
    $("#emClose").onclick = () => ($("#editModal").hidden = true);
    $("#emForm").addEventListener("submit", saveEditor);
    $("#emFields").addEventListener("change", autoDateParts);
    $("#addRecBtn").onclick = () => openEditor(null);
    $("#emFile").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      emPhoto = await resizeToDataUrl(f, 1600);
      $("#emPhPrev").innerHTML = `<img src="${emPhoto}" alt="New photo">`;
      $("#emFileInfo").textContent = `${f.name} – ready to upload (${Math.round((emPhoto.length * 0.75) / 1024)} KB).`;
    };
  }

  // ---------- profiles ----------
  function renderProfiles() {
    const by = group(state.filtered, (r) => r.tigerId || "(blank)");
    const cards = [...by].sort((a, b) => natural(a[0], b[0])).map(([id, l]) => {
      const prof = profilePhotoFor(id);
      const pic = prof || l.slice().reverse().flatMap((r) => r.photos)[0];
      const first = l[0], last = l[l.length - 1];
      const sexCol = state.headers.find((h) => /^(sex|gender)$/i.test(h));
      const sexTxt = first.sex || (sexCol ? first.raw[sexCol] : "");
      return `<div class="profile" style="--c:${colorFor(id)}">
        <div class="ph">${pic ? imgTag(pic, "", id) : `<span>🐅</span>`}
          <button class="ph-set" data-setphoto="${esc(id)}" title="Set profile photo">📷 ${prof ? "Change" : "Set"} photo</button>
          ${prof ? `<span class="ph-tag">Profile photo</span>` : pic ? `<span class="ph-tag">Latest record photo</span>` : ""}</div>
        <div class="pb">
          <h3>${esc(id)}${sexTxt ? ` <small>${esc(sexTxt)}</small>` : ""}</h3>
          <dl>
            <dt>Records</dt><dd>${l.length} <small>(${l.filter((r) => r.hasPhoto).length} with photo)</small></dd>
            <dt>First seen</dt><dd>${esc(first.dateText || period(first))}</dd>
            <dt>Last seen</dt><dd>${esc(last.dateText || period(last))}</dd>
            <dt>Ranges</dt><dd>${esc(uniq(l.map((r) => r.range)).join(", ") || "–")}</dd>
            <dt>Beats</dt><dd>${esc(uniq(l.map((r) => r.beat)).join(", ") || "–")}</dd>
          </dl>
          ${state.profileInfo[id] && state.profileInfo[id].name ? `<p class="pname">“${esc(state.profileInfo[id].name)}”${state.profileInfo[id].remarks ? " – " + esc(state.profileInfo[id].remarks) : ""}</p>` : ""}
          <button class="btn sm" data-tiger="${esc(id)}">Show on map</button>
        </div></div>`;
    });
    $("#profiles").innerHTML = cards.join("") || `<p class="muted">No tigers for this selection.</p>`;
  }

  // ---------- profile photos ----------
  // priority: set in this browser > Tiger_Profiles sheet tab > config.js > latest record photo
  const LS_KEY = "atr_profile_photos";
  const localPhotos = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { return {}; } };
  function profilePhotoFor(id) {
    const local = localPhotos()[id];
    if (local) return local.startsWith("data:") ? { url: local, thumb: local, big: local, alt: "" } : photoLinks(local)[0];
    const sheet = state.profileInfo[id] && state.profileInfo[id].photo;
    const conf = (CFG.profilePhotos || {})[id];
    const u = sheet || conf;
    return u ? photoLinks(u)[0] : null;
  }
  function loadProfiles() {
    state.profileInfo = {};
    if (!CFG.profileCsvUrl) return;
    Papa.parse(CFG.profileCsvUrl + (CFG.profileCsvUrl.includes("?") ? "&" : "?") + "_=" + Date.now(), {
      download: true, header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim(),
      complete: (res) => {
        const H = res.meta.fields || [];
        const c = { id: findColumn(H, ["Tiger_ID", "Tiger ID", "Tiger"]), photo: findColumn(H, ["Profile_Photo_URL", "Profile Photo", "Photo_URL", "Photo"]),
                    name: findColumn(H, ["Name", "Tiger Name"]), remarks: findColumn(H, ["Remarks", "Notes"]) };
        res.data.forEach((r) => { const id = String(r[c.id] || "").trim(); if (id) state.profileInfo[id] = { photo: String(r[c.photo] || "").trim(), name: c.name ? r[c.name] : "", remarks: c.remarks ? r[c.remarks] : "" }; });
        renderProfiles();
      },
    });
  }
  let pmTiger = null, pmData = null;
  function openPhotoModal(id) {
    pmTiger = id; pmData = null;
    $("#pmTiger").textContent = id; $("#pmUrl").value = ""; $("#pmFile").value = "";
    const cur = profilePhotoFor(id);
    $("#pmImg").src = cur ? cur.thumb : ""; $("#pmImg").hidden = !cur;
    $("#photoModal").hidden = false;
  }
  function resizeToDataUrl(file, max = 700) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const im = new Image(); im.onload = () => {
        const k = Math.min(1, max / Math.max(im.width, im.height)); const cv = document.createElement("canvas");
        cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); res(cv.toDataURL("image/jpeg", 0.85)); }; im.onerror = rej; im.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }
  function wirePhotoModal() {
    $("#pmClose").onclick = () => ($("#photoModal").hidden = true);
    $("#pmUrl").oninput = (e) => { const p = photoLinks(e.target.value.trim())[0]; pmData = p ? e.target.value.trim() : null; if (p) { $("#pmImg").src = p.thumb; $("#pmImg").dataset.alt = p.alt || ""; $("#pmImg").hidden = false; } };
    $("#pmImg").onerror = (e) => { const i = e.target; if (i.dataset.alt) { i.src = i.dataset.alt; i.dataset.alt = ""; } };
    $("#pmFile").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; pmData = await resizeToDataUrl(f); $("#pmImg").src = pmData; $("#pmImg").hidden = false; };
    $("#pmSave").onclick = () => {
      if (!pmData) { $("#photoModal").hidden = true; return; }
      const all = localPhotos(); all[pmTiger] = pmData;
      try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { alert("Browser storage is full – use a smaller photo or a link."); return; }
      $("#photoModal").hidden = true; renderProfiles();
    };
    $("#pmRemove").onclick = () => { const all = localPhotos(); delete all[pmTiger]; localStorage.setItem(LS_KEY, JSON.stringify(all)); $("#photoModal").hidden = true; renderProfiles(); };
  }

  // ---------- custom report builder & pivot ----------
  let customOn = false, pivotOn = false;
  function setupBuilders() {
    const H = state.headers;
    const def = new Set((CFG.customDefaultColumns || []).map(norm));
    const prev = new Set([...document.querySelectorAll("#colPick input:checked")].map((i) => i.value));
    $("#colPick").innerHTML = H.map((h) => `<label><input type="checkbox" value="${esc(h)}" ${(prev.size ? prev.has(h) : def.has(norm(h))) ? "checked" : ""}> ${esc(h)}</label>`).join("");
    const opts = H.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join("");
    $("#cSort").innerHTML = `<option value="">(sheet order / date)</option>` + opts;
    const keep = (sel, v) => { const old = sel.value; sel.innerHTML = opts; sel.value = old || v; };
    keep($("#pRows"), state.col.tigerId || H[0]);
    $("#pCols").innerHTML = `<option value="">(none – single total column)</option>` + opts;
    if (!$("#pCols").dataset.init) { $("#pCols").value = state.col.year || ""; $("#pCols").dataset.init = 1; }
  }
  function customData() {
    const cols = [...document.querySelectorAll("#colPick input:checked")].map((i) => i.value);
    let list = state.filtered.slice();
    const sk = $("#cSort").value, dir = +$("#cDir").value;
    if (sk) list.sort((a, b) => dir * natural(a.raw[sk] ?? "", b.raw[sk] ?? "")); else if (dir < 0) list.reverse();
    return { cols, list };
  }
  function letterhead(title) {
    const B = CFG.branding, now = new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });
    return `<div class="rep-head"><img src="${$("#logoLeft").src}" alt=""><div><div class="rh-s">${esc(B.govLine)}</div><h2>${esc(B.titleSmall)}</h2><h4>${esc(title)}</h4></div><img src="${$("#logoRight").src}" alt=""></div>
      <table class="rep-meta"><tr><th>Selection</th><td>${esc(filterSummary())}</td><th>Generated</th><td>${esc(now)}</td></tr></table>`;
  }
  function renderCustom() {
    if (!customOn) return;
    const { cols, list } = customData();
    if (!cols.length) { $("#customOut").innerHTML = `<p class="muted">Tick at least one column.</p>`; return; }
    const photos = $("#cPhotos").checked, pc = state.col.photo;
    const body = list.map((r, n) => `<tr><td>${n + 1}</td>${cols.map((h) => {
      if (photos && h === pc && r.photos.length) return `<td>${r.photos.slice(0, 2).map((p) => imgTag(p, "rthumb")).join("")}</td>`;
      return `<td>${esc(r.raw[h])}</td>`; }).join("")}</tr>`).join("");
    $("#customOut").innerHTML = `<div class="paper">${letterhead($("#cTitle").value || "Custom report")}
      <p class="muted small">${list.length} records · ${cols.length} columns</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>#</th>${cols.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="signs"><div>Prepared by</div><div>Verified by<br><small>Field Director, Amrabad Tiger Reserve</small></div></div></div>`;
  }
  function pivotData() {
    const R = $("#pRows").value, Cc = $("#pCols").value, V = $("#pVal").value, f = state.filtered;
    const val = (l) => (V === "tigers" ? ids(l).length : l.length);
    const rk = uniq(f.map((r) => r.raw[R] ?? "")).sort(R === state.col.month ? (a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b) : natural);
    const ck = Cc ? uniq(f.map((r) => r.raw[Cc] ?? "")).sort(Cc === state.col.month ? (a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b) : natural) : [];
    const headers = [R, ...ck, "Total"];
    const rows = rk.map((k) => { const l = f.filter((r) => (r.raw[R] ?? "") === k); return [k || "(blank)", ...ck.map((c) => val(l.filter((r) => (r.raw[Cc] ?? "") === c)) || ""), val(l)]; });
    rows.push(["Total", ...ck.map((c) => val(f.filter((r) => (r.raw[Cc] ?? "") === c)) || ""), val(f)]);
    const title = `${V === "tigers" ? "Individual tigers" : "Records"} by ${R}${Cc ? " × " + Cc : ""}`;
    return { title, headers, rows };
  }
  function renderPivot() {
    if (!pivotOn) return;
    const t = pivotData();
    $("#pivotOut").innerHTML = `<div class="paper">${letterhead("Abstract – " + t.title)}<div class="table-wrap"><table class="data pivot"><thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map((r, i) => `<tr class="${i === t.rows.length - 1 ? "tot" : ""}">${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="signs"><div>Prepared by</div><div>Verified by<br><small>Field Director, Amrabad Tiger Reserve</small></div></div></div>`;
  }
  function saveFile(aoa, name, csv) {
    if (csv) {
      const blob = new Blob(["\ufeff" + Papa.unparse(aoa)], { type: "text/csv;charset=utf-8" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name + ".csv" }); document.body.appendChild(a); a.click(); a.remove();
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[CFG.branding.titleSmall + " – " + CFG.branding.titleMain], ["Selection", filterSummary()], [], ...aoa]), "Report");
      XLSX.writeFile(wb, name + ".xlsx");
    }
  }
  function printPane(pane) {
    document.body.dataset.print = pane;
    setTimeout(() => { window.print(); }, 200);
  }
  window.addEventListener("afterprint", () => { document.body.dataset.print = ""; });
  function wireBuilders() {
    $("#rType").addEventListener("change", renderReport);
    document.querySelectorAll(".rtab").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".rtab").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll(".rpane").forEach((p) => (p.hidden = p.dataset.r !== b.dataset.r));
      $("#view-report .page-head .toolbar").hidden = b.dataset.r !== "abstract";
    }));
    $("#colAll").onclick = () => document.querySelectorAll("#colPick input").forEach((i) => (i.checked = true));
    $("#colNone").onclick = () => document.querySelectorAll("#colPick input").forEach((i) => (i.checked = false));
    $("#colDef").onclick = () => { const d = new Set((CFG.customDefaultColumns || []).map(norm)); document.querySelectorAll("#colPick input").forEach((i) => (i.checked = d.has(norm(i.value)))); };
    $("#cGen").onclick = () => { customOn = true; renderCustom(); };
    const customAoA = () => { const { cols, list } = customData(); return [["#", ...cols], ...list.map((r, n) => [n + 1, ...cols.map((h) => r.raw[h] ?? "")])]; };
    $("#cXlsx").onclick = () => saveFile(customAoA(), `ATR_custom_report_${stamp()}`);
    $("#cCsv").onclick = () => saveFile(customAoA(), `ATR_custom_report_${stamp()}`, true);
    $("#cPrint").onclick = () => { customOn = true; renderCustom(); printPane("custom"); };
    $("#pGen").onclick = () => { pivotOn = true; renderPivot(); };
    $("#pXlsx").onclick = () => { const t = pivotData(); saveFile([[t.title], t.headers, ...t.rows], `ATR_abstract_${stamp()}`); };
    $("#pPrint").onclick = () => { pivotOn = true; renderPivot(); printPane("pivot"); };
  }

  // ---------- report ----------
  function group(list, keyFn) {
    const m = new Map();
    list.forEach((r) => { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return m;
  }
  const ids = (list) => uniq(list.map((r) => r.tigerId)).sort(natural);
  const period = (r) => (r.month ? r.month.slice(0, 3) + " " : "") + (r.year || "");

  function buildReportTables() {
    const f = state.filtered;
    const T = [];
    T.push({ title: "Tiger-wise summary",
      headers: ["Tiger ID", "Sex", "Records", "With photo", "First record", "Last record", "Divisions", "Ranges", "Beats"],
      rows: [...group(f, (r) => r.tigerId || "(blank)")].sort((a, b) => natural(a[0], b[0])).map(([k, l]) => [
        k, l[0].sex, l.length, l.filter((r) => r.hasPhoto).length, l[0].dateText || period(l[0]), l[l.length - 1].dateText || period(l[l.length - 1]),
        uniq(l.map((r) => r.division)).join(", "), uniq(l.map((r) => r.range)).join(", "), uniq(l.map((r) => r.beat)).join(", ")]) });
    T.push({ title: "Division / Range-wise summary",
      headers: ["Division", "Range", "Records", "Individual tigers", "With photo", "Without photo", "Tiger IDs"],
      rows: [...group(f, (r) => r.division + "\u0001" + r.range)].sort((a, b) => natural(a[0], b[0])).map(([k, l]) => {
        const [d, rg] = k.split("\u0001");
        return [d || "(blank)", rg || "(blank)", l.length, ids(l).length, l.filter((r) => r.hasPhoto).length, l.filter((r) => !r.hasPhoto).length, ids(l).join(", ")]; }) });
    T.push({ title: "Section / Beat-wise summary",
      headers: ["Division", "Range", "Section", "Beat", "Compartments", "Records", "Individual tigers", "With photo", "Tiger IDs"],
      rows: [...group(f, (r) => [r.division, r.range, r.section, r.beat].join("\u0001"))].sort((a, b) => natural(a[0], b[0])).map(([k, l]) =>
        [...k.split("\u0001").map((x) => x || "–"), uniq(l.map((r) => r.compt)).length, l.length, ids(l).length, l.filter((r) => r.hasPhoto).length, ids(l).join(", ")]) });
    T.push({ title: "Compartment-wise summary",
      headers: ["Range", "Beat", "Compt. No", "Records", "Individual tigers", "With photo", "Tiger IDs"],
      rows: [...group(f, (r) => [r.range, r.beat, r.compt].join("\u0001"))].sort((a, b) => natural(a[0], b[0])).map(([k, l]) =>
        [...k.split("\u0001").map((x) => x || "–"), l.length, ids(l).length, l.filter((r) => r.hasPhoto).length, ids(l).join(", ")]) });
    {
      const pr = [...group(f, (r) => r.division + "\u0001" + r.range)].sort((a, b) => natural(a[0], b[0])).map(([k, l]) => {
        const [d, rg] = k.split("\u0001"), w = l.filter((r) => r.hasPhoto);
        return [d || "–", rg || "–", w.length, l.length - w.length, l.length, l.length ? Math.round((100 * w.length) / l.length) + "%" : "–", ids(w).length];
      });
      const w = f.filter((r) => r.hasPhoto);
      pr.push(["Total", "", w.length, f.length - w.length, f.length, f.length ? Math.round((100 * w.length) / f.length) + "%" : "–", ids(w).length]);
      T.push({ title: "Photo / No-photo summary", headers: ["Division", "Range", "With photo", "Without photo", "Total records", "% with photo", "Tigers photographed"], rows: pr });
    }
    T.push({ title: "Year / Month-wise summary",
      headers: ["Year", "Month", "Records", "Individual tigers", "With photo", "Tiger IDs"],
      rows: [...group(f, (r) => r.year + "\u0001" + r.month)].sort((a, b) => {
        const [ya, ma] = a[0].split("\u0001"), [yb, mb] = b[0].split("\u0001");
        return natural(ya, yb) || MONTHS.indexOf(ma) - MONTHS.indexOf(mb);
      }).map(([k, l]) => { const [y, m] = k.split("\u0001"); return [y || "–", m || "–", l.length, ids(l).length, l.filter((r) => r.hasPhoto).length, ids(l).join(", ")]; }) });
    const ranges = uniq(f.map((r) => r.range)).sort(natural);
    if (ranges.length && ranges.length <= 25) {
      T.push({ title: "Tiger × Range records (count)", headers: ["Tiger ID", ...ranges, "Total"],
        rows: [...group(f, (r) => r.tigerId || "(blank)")].sort((a, b) => natural(a[0], b[0])).map(([t, l]) => [t, ...ranges.map((rg) => l.filter((r) => r.range === rg).length || ""), l.length]) });
    }
    // Year × Month abstract
    const years = uniq(f.map((r) => r.year)).sort(natural);
    const monthsPresent = MONTHS.filter((m) => f.some((r) => r.month === m));
    if (years.length) {
      T.push({ title: "Abstract: Year × Month records", headers: ["Year", ...monthsPresent.map((m) => m.slice(0, 3)), "Total", "Individual tigers"],
        rows: years.map((y) => { const l = f.filter((r) => r.year === y); return [y, ...monthsPresent.map((m) => l.filter((r) => r.month === m).length || ""), l.length, ids(l).length]; })
          .concat([["Total", ...monthsPresent.map((m) => f.filter((r) => r.month === m).length || ""), f.length, ids(f).length]]) });
      T.push({ title: "Abstract: Range × Year individual tigers", headers: ["Division", "Range", ...years, "All years"],
        rows: [...group(f, (r) => r.division + "\u0001" + r.range)].sort((a, b) => natural(a[0], b[0])).map(([k, l]) => {
          const [d, rg] = k.split("\u0001"); return [d || "–", rg || "–", ...years.map((y) => ids(l.filter((r) => r.year === y)).length || ""), ids(l).length]; }) });
      T.push({ title: "Abstract: Tiger × Year records", headers: ["Tiger ID", "Sex", ...years, "Total"],
        rows: [...group(f, (r) => r.tigerId || "(blank)")].sort((a, b) => natural(a[0], b[0])).map(([t, l]) => [t, l[0].sex || "", ...years.map((y) => l.filter((r) => r.year === y).length || ""), l.length]) });
    }
    if (f.some((r) => r.evidence)) {
      T.push({ title: "Evidence-type summary", headers: ["Evidence type", "Records", "Individual tigers", "With photo"],
        rows: [...group(f, (r) => r.evidence || "(blank)")].sort((a, b) => b[1].length - a[1].length).map(([k, l]) => [k, l.length, ids(l).length, l.filter((r) => r.hasPhoto).length]) });
    }
    return T;
  }

  function tableHtml(t, n) {
    const head = `<h3><span class="num">${n}</span>${esc(t.title)}</h3>`;
    if (!t.rows.length) return head + `<p class="muted">No records for this selection.</p>`;
    return head + `<div class="table-wrap"><table class="data"><thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function renderReport() {
    const f = state.filtered;
    const all = buildReportTables();
    all.push({ title: "Detailed record list", detail: true, headers: ["#", "Tiger ID", "Date / Period", "Evidence", "Division", "Range", "Section", "Beat", "Compt. No", "Latitude", "Longitude", "Photo"],
      rows: f.map((r, n) => [n + 1, r.tigerId, r.dateText || period(r), r.evidence, r.division, r.range, r.section, r.beat, r.compt, r.hasCoord ? r.lat : "", r.hasCoord ? r.lon : "", r.photos[0] ? r.photos[0].url : r.hasPhoto ? "Yes" : "No"]) });
    const sel = $("#rType");
    const cur = sel.value;
    sel.innerHTML = `<option value="">All summaries (full abstract report)</option>` + all.map((t) => `<option ${t.title === cur ? "selected" : ""}>${esc(t.title)}</option>`).join("");
    const picked = cur ? all.filter((t) => t.title === cur) : all;
    const tables = picked.filter((t) => !t.detail);
    const showDetail = picked.some((t) => t.detail);
    const now = new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });
    const B = CFG.branding;
    const repTitle = cur || "Detailed Abstract Report";
    const detail = f.map((r, n) => {
      const pics = r.photos.slice(0, 3).map((p) => imgTag(p, "rthumb")).join("");
      return `<tr><td>${n + 1}</td><td><b>${esc(r.tigerId)}</b></td><td>${esc(r.dateText || period(r))}</td><td>${esc(r.division)}</td><td>${esc(r.range)}</td><td>${esc(r.section)}</td><td>${esc(r.beat)}</td><td>${esc(r.block)}</td><td>${esc(r.compt)}</td>
        <td>${r.hasCoord ? r.lat.toFixed(5) + ", " + r.lon.toFixed(5) : "–"}</td><td>${pics || (r.hasPhoto ? "Yes" : "No")}</td></tr>`;
    }).join("");
    $("#report").innerHTML = `<div class="paper">
      <div class="rep-head">
        <img src="${$("#logoLeft").src}" alt=""><div><div class="rh-s">${esc(B.govLine)}</div><h2>${esc(B.titleSmall)}</h2><h4>${esc(B.titleMain)} – ${esc(repTitle)}</h4></div><img src="${$("#logoRight").src}" alt="">
      </div>
      <table class="rep-meta"><tr><th>Selection</th><td>${esc(filterSummary())}</td><th>Generated</th><td>${esc(now)}</td></tr></table>
      <div class="rep-kpis">${kpiData().map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}</div>
      ${tables.map((t, i) => tableHtml(t, i + 1)).join("")}
      ${showDetail ? `<h3><span class="num">${tables.length + 1}</span>Detailed record list (${f.length})</h3>
      <div class="table-wrap"><table class="data detail"><thead><tr><th>#</th><th>Tiger ID</th><th>Date / Period</th><th>Division</th><th>Range</th><th>Section</th><th>Beat</th><th>Block</th><th>Compt</th><th>Lat, Long</th><th>Photo</th></tr></thead><tbody>${detail}</tbody></table></div>` : ""}
      <div class="signs"><div>Prepared by</div><div>Verified by<br><small>Field Director, Amrabad Tiger Reserve</small></div></div>
    </div>`;
    state.reportTables = picked;
  }

  // ---------- records table ----------
  function renderRecords() {
    const heads = state.headers;
    let list = state.filtered.slice();
    if (state.sortKey) list.sort((a, b) => state.sortDir * natural(a.raw[state.sortKey] ?? "", b.raw[state.sortKey] ?? ""));
    $("#recCount").textContent = `${list.length} of ${state.records.length} records · click a row to locate on map`;
    const photoCol = state.col.photo;
    $("#recordsTable").innerHTML = `<table class="data"><thead><tr><th>Edit</th>${heads.map((h) => `<th data-h="${esc(h)}" class="sortable">${esc(h)}${state.sortKey === h ? (state.sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>
      ${list.map((r) => `<tr data-i="${r.i}" class="go"><td><button class="ed-btn" data-edit="${r.i}" title="Edit / add photo">✏</button></td>${heads.map((h) => {
        if (h === photoCol && r.photos.length) return `<td>${r.photos.slice(0, 3).map((p) => imgTag(p, "rthumb")).join("")}</td>`;
        return `<td>${esc(r.raw[h])}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table>`;
  }

  // ---------- exports ----------
  const filteredAoA = () => [state.headers, ...state.filtered.map((r) => state.headers.map((h) => r.raw[h] ?? ""))];
  const stamp = () => new Date().toISOString().slice(0, 10);
  function downloadCsv() {
    const blob = new Blob(["﻿" + Papa.unparse(filteredAoA())], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `ATR_tiger_records_${stamp()}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadXlsx() {
    const wb = XLSX.utils.book_new();
    const info = [[CFG.branding.titleSmall + " – " + CFG.branding.titleMain], ["Selection", filterSummary()], ["Generated", new Date().toLocaleString("en-IN")], [], ...kpiData().map(([l, v]) => [l, v])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), "Summary");
    (state.reportTables || []).forEach((t) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.headers, ...t.rows]), t.title.replace(/[\\/?*[\]:×]/g, "").slice(0, 31)));
    if (!$("#rType").value) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filteredAoA()), "All sheet columns");
    XLSX.writeFile(wb, `ATR_tiger_report_${stamp()}.xlsx`);
  }

  // ---------- UI wiring ----------
  function switchView(v) {
    if (v !== "map" && $("#view-map").classList.contains("map-full")) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); setMapFull(false); }
    document.querySelectorAll(".menu[data-view]").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
    setTimeout(() => { map && map.invalidateSize(); mini && mini.invalidateSize();
      if (v === "map" && state.fitMain && state.lastBounds) { state.fitMain = false; map.fitBounds(state.lastBounds, { maxZoom: 15 }); }
      if (v === "dashboard" && state.fitMini && state.lastBounds) { state.fitMini = false; mini.fitBounds(state.lastBounds, { maxZoom: 14 }); } Object.values(charts).forEach((c) => c.resize()); }, 60);
  }
  function locate(r) {
    if (!r || !r.hasCoord) return;
    switchView("map");
    setTimeout(() => { map.setView([r.lat, r.lon], 16); L.popup({ maxWidth: 360 }).setLatLng([r.lat, r.lon]).setContent(popupHtml(r)).openOn(map); }, 120);
  }
  function openLightbox(img) {
    const lb = $("#lightbox");
    const li = lb.querySelector("img");
    li.dataset.alt = img.dataset.alt ? img.dataset.alt.replace(/=w\d+$/, "=w1600") : "";
    li.onerror = () => { if (li.dataset.alt) { li.src = li.dataset.alt; li.dataset.alt = ""; } };
    li.src = img.dataset.tried ? img.src : (img.dataset.big || img.src);
    lb.querySelector(".lb-open").href = img.dataset.url || img.src;
    lb.hidden = false;
  }
  function applyBranding() {
    const B = CFG.branding;
    $("#govLine").textContent = B.govLine; $("#titleSmall").textContent = B.titleSmall;
    $("#titleMain").textContent = B.titleMain; $("#titleSub").textContent = B.titleSub;
    if (B.logoLeft) $("#logoLeft").src = B.logoLeft;
    if (B.logoRight) $("#logoRight").src = B.logoRight;
    document.title = B.titleSmall + " – " + B.titleMain;
    $("#yr").textContent = new Date().getFullYear();
    const tick = () => ($("#clock").textContent = new Date().toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    tick(); setInterval(tick, 30000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyBranding();
    state.profileInfo = {};
    wirePhotoModal(); wireBuilders(); wireEditor(); loadProfiles();
    initMaps();
    document.querySelectorAll(".menu[data-view]").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
    document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); switchView(a.dataset.goto); }));
    $("#f_photo").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      $("#f_photo").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      state.pPhoto = b.dataset.v; refreshOptions(); markDirty();
    });
    $("#f_search").addEventListener("input", (e) => { state.pSearch = e.target.value.trim().toLowerCase(); markDirty(); });
    $("#f_search").addEventListener("keydown", (e) => { if (e.key === "Enter") commitFilters(); });
    $("#applyBtn").addEventListener("click", commitFilters);
    $("#resetBtn").addEventListener("click", () => {
      state.pending = {}; state.pPhoto = ""; state.pSearch = ""; $("#f_search").value = "";
      $("#f_photo").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === ""));
      commitFilters();
    });
    if (0) $("#fpCollapse").addEventListener("click", () => { $("#filterPanel").hidden = true; $("#fpOpen").hidden = false; switchView(document.querySelector(".menu.active").dataset.view); });
    if (0) $("#fpOpen").addEventListener("click", () => { $("#filterPanel").hidden = false; $("#fpOpen").hidden = true; switchView(document.querySelector(".menu.active").dataset.view); });
    $("#refreshBtn").addEventListener("click", load);
    $("#printBtn").addEventListener("click", () => { switchView("report"); printPane("abstract"); });
    $("#csvBtn").addEventListener("click", downloadCsv);
    $("#csvBtn2").addEventListener("click", downloadCsv);
    $("#xlsxBtn").addEventListener("click", downloadXlsx);
    $("#recordsTable").addEventListener("click", (e) => {
      const th = e.target.closest("th.sortable");
      if (th) { const h = th.dataset.h; state.sortDir = state.sortKey === h ? -state.sortDir : 1; state.sortKey = h; renderRecords(); }
    });
    document.addEventListener("click", (e) => {
      if (e.target.classList.contains("pthumb")) { e.preventDefault(); openLightbox(e.target); return; }
      if (e.target.matches(".lightbox, .lb-close")) { $("#lightbox").hidden = true; return; }
      const ed = e.target.closest("[data-edit]");
      if (ed) { e.stopPropagation(); openEditor(state.records[+ed.dataset.edit], !!ed.dataset.photo); return; }
      const tr = e.target.closest("tr.go[data-i]");
      if (tr) { locate(state.records[+tr.dataset.i]); return; }
      const sp = e.target.closest("[data-setphoto]");
      if (sp) { openPhotoModal(sp.dataset.setphoto); return; }
      const tb = e.target.closest("[data-tiger]");
      if (tb) {
        state.pending = { ...state.filters, tigerId: tb.dataset.tiger }; commitFilters(); switchView("map");
      }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lightbox").hidden = true; });
    // Photo that cannot be shown (not shared publicly, deleted…) → fallback
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("pthumb")) return;
      if (img.dataset.alt && !img.dataset.tried) { img.dataset.tried = "1"; img.src = img.dataset.alt; return; }
      const holder = img.closest(".ph");
      if (holder) { holder.innerHTML = "<span>🐅</span>"; return; }
      const a = Object.assign(document.createElement("a"), { href: img.dataset.url, target: "_blank", rel: "noopener", textContent: "📷 Open photo", className: "photo-link" });
      img.replaceWith(a);
    }, true);
    load();
  });

  window.__ATR = { state, parseCoord, parseDate, photoLinks, ingest };
})();
