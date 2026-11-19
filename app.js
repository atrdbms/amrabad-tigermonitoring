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
        return { url, thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w600`, big: `https://drive.google.com/thumbnail?id=${id}&sz=w1600` };
      }
      return { url, thumb: url, big: url };
    });
  }

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

    mini = L.map("miniMap", { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(CFG.mapCenter, CFG.mapZoom);
    baseLayers()["Google Satellite (labels)"].addTo(mini);
    miniLayer = L.layerGroup().addTo(mini);
  }

  function marker(r) {
    const m = L.circleMarker([r.lat, r.lon], { radius: 8, weight: r.hasPhoto ? 3 : 2, color: r.hasPhoto ? "#ffd400" : "#fff", fillColor: colorFor(r.tigerId), fillOpacity: 0.95 });
    m.bindPopup(() => popupHtml(r), { maxWidth: 360, minWidth: 270 });
    m.bindTooltip(esc(r.tigerId || "Unknown") + (r.month ? " · " + esc(r.month) + " " + esc(r.year) : ""));
    return m;
  }

  function popupHtml(r) {
    const skip = new Set([state.col.photo, state.col.lat, state.col.lon].filter(Boolean));
    const rows = state.headers.filter((h) => !skip.has(h) && String(r.raw[h] ?? "").trim() !== "")
      .map((h) => `<tr><th>${esc(h)}</th><td>${esc(r.raw[h])}</td></tr>`).join("");
    const pics = r.photos.map((p) => `<img class="pthumb" loading="lazy" src="${esc(p.thumb)}" data-big="${esc(p.big)}" data-url="${esc(p.url)}" alt="Photo of ${esc(r.tigerId)}">`).join("");
    const photoBlock = pics ? `<div class="pgal">${pics}</div>` : `<div class="nophoto">${r.hasPhoto ? "Photo: " + esc(r.raw[state.col.photo]) : "No photo"}</div>`;
    return `<div class="popup">
      <div class="pop-h" style="--c:${colorFor(r.tigerId)}">${esc(r.tigerId || "Unknown tiger")}<small>${esc(r.dateText || period(r))}</small></div>
      <div class="coords">${r.lat.toFixed(5)}° N, ${r.lon.toFixed(5)}° E · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${r.lat},${r.lon}&t=k">Google Maps ↗</a></div>
      ${photoBlock}<table>${rows}</table></div>`;
  }

  function renderMaps(fit) {
    if (!map) return;
    cluster.clearLayers(); pathLayer.clearLayers(); miniLayer.clearLayers();
    const pts = state.filtered.filter((r) => r.hasCoord);
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
      map.fitBounds(b, { maxZoom: 15 }); mini.fitBounds(b, { maxZoom: 14 });
    }
    const noCoord = state.filtered.length - pts.length;
    const tigers = ids(pts).slice(0, 30);
    $("#mapNote").innerHTML = `<div class="lg-title">Legend</div>` +
      tigers.map((t) => `<div><i class="lg" style="background:${colorFor(t)}"></i>${esc(t)}</div>`).join("") +
      `<div><i class="lg ring"></i>With photo</div>` +
      (noCoord ? `<div class="warn">${noCoord} record(s) without valid Lat/Long</div>` : "");
  }

  // ---------- profiles ----------
  function renderProfiles() {
    const by = group(state.filtered, (r) => r.tigerId || "(blank)");
    const cards = [...by].sort((a, b) => natural(a[0], b[0])).map(([id, l]) => {
      const pic = l.slice().reverse().flatMap((r) => r.photos)[0];
      const first = l[0], last = l[l.length - 1];
      const sexCol = state.headers.find((h) => /^(sex|gender)$/i.test(h));
      const sexTxt = first.sex || (sexCol ? first.raw[sexCol] : "");
      return `<div class="profile" style="--c:${colorFor(id)}">
        <div class="ph">${pic ? `<img class="pthumb" loading="lazy" src="${esc(pic.thumb)}" data-big="${esc(pic.big)}" data-url="${esc(pic.url)}" alt="${esc(id)}">` : `<span>🐅</span>`}</div>
        <div class="pb">
          <h3>${esc(id)}${sexTxt ? ` <small>${esc(sexTxt)}</small>` : ""}</h3>
          <dl>
            <dt>Records</dt><dd>${l.length} <small>(${l.filter((r) => r.hasPhoto).length} with photo)</small></dd>
            <dt>First seen</dt><dd>${esc(first.dateText || period(first))}</dd>
            <dt>Last seen</dt><dd>${esc(last.dateText || period(last))}</dd>
            <dt>Ranges</dt><dd>${esc(uniq(l.map((r) => r.range)).join(", ") || "–")}</dd>
            <dt>Beats</dt><dd>${esc(uniq(l.map((r) => r.beat)).join(", ") || "–")}</dd>
          </dl>
          <button class="btn sm" data-tiger="${esc(id)}">Show on map</button>
        </div></div>`;
    });
    $("#profiles").innerHTML = cards.join("") || `<p class="muted">No tigers for this selection.</p>`;
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
      headers: ["Range", "Section", "Beat", "Block", "Compt. No", "Records", "Individual tigers", "Tiger IDs"],
      rows: [...group(f, (r) => [r.range, r.section, r.beat, r.block, r.compt].join("\u0001"))].sort((a, b) => natural(a[0], b[0])).map(([k, l]) =>
        [...k.split("\u0001").map((x) => x || "–"), l.length, ids(l).length, ids(l).join(", ")]) });
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
      T.push({ title: "Abstract: Evidence type", headers: ["Evidence type", "Records", "Individual tigers", "With photo"],
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
    const tables = buildReportTables();
    const now = new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });
    const B = CFG.branding;
    const detail = f.map((r, n) => {
      const pics = r.photos.slice(0, 3).map((p) => `<img class="rthumb pthumb" loading="lazy" src="${esc(p.thumb)}" data-big="${esc(p.big)}" data-url="${esc(p.url)}" alt="">`).join("");
      return `<tr><td>${n + 1}</td><td><b>${esc(r.tigerId)}</b></td><td>${esc(r.dateText || period(r))}</td><td>${esc(r.division)}</td><td>${esc(r.range)}</td><td>${esc(r.section)}</td><td>${esc(r.beat)}</td><td>${esc(r.block)}</td><td>${esc(r.compt)}</td>
        <td>${r.hasCoord ? r.lat.toFixed(5) + ", " + r.lon.toFixed(5) : "–"}</td><td>${pics || (r.hasPhoto ? "Yes" : "No")}</td></tr>`;
    }).join("");
    $("#report").innerHTML = `<div class="paper">
      <div class="rep-head">
        <img src="${esc(B.logoLeft)}" alt=""><div><div class="rh-s">${esc(B.govLine)}</div><h2>${esc(B.titleSmall)}</h2><h4>${esc(B.titleMain)} – Detailed Report</h4></div><img src="${esc(B.logoRight)}" alt="">
      </div>
      <table class="rep-meta"><tr><th>Selection</th><td>${esc(filterSummary())}</td><th>Generated</th><td>${esc(now)}</td></tr></table>
      <div class="rep-kpis">${kpiData().map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}</div>
      ${tables.map((t, i) => tableHtml(t, i + 1)).join("")}
      <h3><span class="num">${tables.length + 1}</span>Record details (${f.length})</h3>
      <div class="table-wrap"><table class="data detail"><thead><tr><th>#</th><th>Tiger ID</th><th>Date / Period</th><th>Division</th><th>Range</th><th>Section</th><th>Beat</th><th>Block</th><th>Compt</th><th>Lat, Long</th><th>Photo</th></tr></thead><tbody>${detail}</tbody></table></div>
      <div class="signs"><div>Prepared by</div><div>Verified by<br><small>Field Director, Amrabad Tiger Reserve</small></div></div>
    </div>`;
    state.reportTables = tables;
  }

  // ---------- records table ----------
  function renderRecords() {
    const heads = state.headers;
    let list = state.filtered.slice();
    if (state.sortKey) list.sort((a, b) => state.sortDir * natural(a.raw[state.sortKey] ?? "", b.raw[state.sortKey] ?? ""));
    $("#recCount").textContent = `${list.length} of ${state.records.length} records · click a row to locate on map`;
    const photoCol = state.col.photo;
    $("#recordsTable").innerHTML = `<table class="data"><thead><tr>${heads.map((h) => `<th data-h="${esc(h)}" class="sortable">${esc(h)}${state.sortKey === h ? (state.sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>
      ${list.map((r) => `<tr data-i="${r.i}" class="go">${heads.map((h) => {
        if (h === photoCol && r.photos.length) return `<td>${r.photos.slice(0, 3).map((p) => `<img class="rthumb pthumb" loading="lazy" src="${esc(p.thumb)}" data-big="${esc(p.big)}" data-url="${esc(p.url)}" alt="">`).join("")}</td>`;
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
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filteredAoA()), "Records");
    XLSX.writeFile(wb, `ATR_tiger_report_${stamp()}.xlsx`);
  }

  // ---------- UI wiring ----------
  function switchView(v) {
    document.querySelectorAll(".menu[data-view]").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
    setTimeout(() => { map && map.invalidateSize(); mini && mini.invalidateSize(); Object.values(charts).forEach((c) => c.resize()); }, 60);
  }
  function locate(r) {
    if (!r || !r.hasCoord) return;
    switchView("map");
    setTimeout(() => { map.setView([r.lat, r.lon], 16); L.popup({ maxWidth: 360 }).setLatLng([r.lat, r.lon]).setContent(popupHtml(r)).openOn(map); }, 120);
  }
  function openLightbox(img) {
    const lb = $("#lightbox");
    lb.querySelector("img").src = img.dataset.big || img.src;
    lb.querySelector(".lb-open").href = img.dataset.url || img.src;
    lb.hidden = false;
  }
  function applyBranding() {
    const B = CFG.branding;
    $("#govLine").textContent = B.govLine; $("#titleSmall").textContent = B.titleSmall;
    $("#titleMain").textContent = B.titleMain; $("#titleSub").textContent = B.titleSub;
    $("#logoLeft").src = B.logoLeft; $("#logoRight").src = B.logoRight;
    document.title = B.titleSmall + " – " + B.titleMain;
    $("#yr").textContent = new Date().getFullYear();
    const tick = () => ($("#clock").textContent = new Date().toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    tick(); setInterval(tick, 30000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyBranding();
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
    $("#printBtn").addEventListener("click", () => { switchView("report"); setTimeout(() => window.print(), 300); });
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
      const tr = e.target.closest("tr.go[data-i]");
      if (tr) { locate(state.records[+tr.dataset.i]); return; }
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
      const holder = img.closest(".ph");
      if (holder) { holder.innerHTML = "<span>🐅</span>"; return; }
      const a = Object.assign(document.createElement("a"), { href: img.dataset.url, target: "_blank", rel: "noopener", textContent: "📷 Open photo", className: "photo-link" });
      img.replaceWith(a);
    }, true);
    load();
  });

  window.__ATR = { state, parseCoord, parseDate, photoLinks, ingest };
})();
