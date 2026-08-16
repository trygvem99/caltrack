// CalTrack frontend — vanilla JS, no build step. Storage: db.js (IndexedDB).
// LLM calls: llm.js (direct browser -> Anthropic). Math: math.js.
"use strict";

const $ = (sel) => document.querySelector(sel);
const { rollingMean7, linearFitSlope, tdeeSuggestion, recipePer100g, daysBetween, round1: r1 } = CalMath;

let profile = null;
let log = [];        // all log entries
let foods = [];      // food DB
let weights = [];    // all weigh-ins
let series = [];     // weight series
let corrections = [];

let logDate = null;          // the day being logged to; null until init sets today
let scanItems = [];          // items being reviewed before save
let scanQuestion = null;
let scanRevisions = [];      // spoken corrections this review; flushed to the ledger on save
let editingEntryId = null;   // set when re-opening a saved entry
let editingPrevItems = null; // snapshot for post-save correction diff

const UNC = { label: 0.05, weighed: 0.05, photo: 0.25, recalled: 0.4, legacy: 0.3 };
const DEFAULT_TARGETS = [3050, 2500, 2500, 2500, 3050, 3050, 3050]; // getDay(): Sun..Sat

// ---------- helpers ----------
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dateNDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const entryTotals = (items) => ({
  kcal: Math.round(items.reduce((s, i) => s + i.kcal, 0)),
  protein_g: r1(items.reduce((s, i) => s + i.protein_g, 0)),
  carbs_g: r1(items.reduce((s, i) => s + i.carbs_g, 0)),
  fat_g: r1(items.reduce((s, i) => s + i.fat_g, 0)),
});
const dayEntries = (date) => log.filter((e) => e.date === date);
const dayTotals = (date) => entryTotals(dayEntries(date).flatMap((e) => e.items));
const isLegacyOnly = (date) => {
  const items = dayEntries(date).flatMap((e) => e.items);
  return items.length > 0 && items.every((i) => i.provenance === "legacy");
};
// Uncertainty range for a saved item. An untouched model estimate keeps the
// model's (possibly asymmetric) interval, scaled to the logged portion. Once the
// user or a food-DB match has overridden the estimate, that interval no longer
// describes the number on screen — fall back to the item's own unc, which
// tracks its current provenance.
const savedItemRange = (i) => {
  if (!i.corrected && i.est && i.est.kcal > 0 && i.est.portion_g > 0) {
    const f = i.portion_g / i.est.portion_g;
    return [i.est.kcal_low * f, i.est.kcal_high * f];
  }
  const u = i.unc ?? 0.25;
  return [i.kcal * (1 - u), i.kcal * (1 + u)];
};
const dayRange = (date) => {
  const items = dayEntries(date).flatMap((e) => e.items);
  return items.reduce(([lo, hi], i) => {
    const [l, h] = savedItemRange(i);
    return [lo + l, hi + h];
  }, [0, 0]);
};
const kcalTargetFor = (date) => {
  const day = new Date(date + "T12:00:00").getDay();
  return (profile?.kcal_targets || DEFAULT_TARGETS)[day];
};
const activeSeries = () => {
  const s = series.filter((x) => !x.legacy).sort((a, b) => (a.start < b.start ? 1 : -1));
  return s[0] || null;
};
// A back-dated weigh-in belongs to whichever series was running on that date,
// not to whatever series happens to be newest now.
const seriesForDate = (date) => {
  const s = series.filter((x) => !x.legacy && x.start <= date).sort((a, b) => (a.start < b.start ? 1 : -1));
  return s[0] || null;
};
const seriesWeights = (s) =>
  weights.filter((w) => w.series === s.id).sort((a, b) => (a.date < b.date ? -1 : 1));

// ---------- views ----------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  $(`#view-${name}`).hidden = false;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "today") {
    if (logDate && logDate > todayStr()) logDate = todayStr();
    renderToday();
  }
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ---------- today ----------
function renderToday() {
  renderWeightCard();
  renderBackupNag();

  renderDateNav();
  const t = dayTotals(logDate);
  const [lo, hi] = dayRange(logDate);
  const kcalTarget = kcalTargetFor(logDate);
  const protTarget = profile?.protein_target || 0;

  $("#kcal-nums").textContent = `${t.kcal} / ${kcalTarget} kcal`;
  $("#kcal-bar").style.width = Math.min(100, (t.kcal / kcalTarget) * 100) + "%";
  $("#kcal-bar").classList.toggle("over", t.kcal > kcalTarget);
  const left = kcalTarget - t.kcal;
  const rangeTxt = t.kcal ? `${Math.round(lo)}–${Math.round(hi)} of ${kcalTarget} · ` : "";
  $("#kcal-sub").innerHTML = `<span class="range-sub">${rangeTxt}</span>${left >= 0 ? `${left} kcal remaining` : `${-left} kcal over`}`;

  $("#prot-nums").textContent = protTarget ? `${Math.round(t.protein_g)} / ${protTarget} g` : `${Math.round(t.protein_g)} g`;
  $("#prot-bar").style.width = (protTarget ? Math.min(100, (t.protein_g / protTarget) * 100) : 0) + "%";
  $("#prot-sub").textContent = protTarget
    ? t.protein_g >= protTarget ? "Protein goal hit ✓" : `${Math.round(protTarget - t.protein_g)} g to go`
    : "";

  $("#tier-line").textContent = tierLine(logDate);

  const list = $("#meal-list");
  const entries = dayEntries(logDate).sort((a, b) => (a.time < b.time ? -1 : 1));
  list.innerHTML = entries.length ? "" : `<div class="empty">Nothing logged ${logDate === todayStr() ? "yet" : "for this day"}.</div>`;
  for (const e of entries) list.appendChild(mealCard(e));
}

// ---------- which day am I logging to ----------
const shiftDate = (date, days) => {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const prettyDate = (date) =>
  new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

function setLogDate(date) {
  if (date > todayStr()) return;          // no logging into the future
  logDate = date;
  renderToday();
}

function renderDateNav() {
  $("#log-date").value = logDate;
  $("#log-date").max = todayStr();
  $("#date-next").disabled = logDate >= todayStr();
  const back = logDate !== todayStr();
  $("#backdate-note").hidden = !back;
  if (back) {
    const ago = daysBetween(logDate, todayStr());
    $("#backdate-note").innerHTML =
      `Logging to <b>${prettyDate(logDate)}</b> (${ago} day${ago === 1 ? "" : "s"} ago) — <a href="#" id="back-to-today">back to today</a>`;
    $("#back-to-today").addEventListener("click", (e) => { e.preventDefault(); setLogDate(todayStr()); });
  }
}

$("#date-prev").addEventListener("click", () => setLogDate(shiftDate(logDate, -1)));
$("#date-next").addEventListener("click", () => setLogDate(shiftDate(logDate, 1)));
$("#log-date").addEventListener("change", (e) => {
  if (e.target.value) setLogDate(e.target.value);
  else renderDateNav();
});

function tierLine(date) {
  const items = dayEntries(date).flatMap((e) => e.items);
  const total = items.reduce((s, i) => s + i.kcal, 0);
  if (!total) return "";
  const groups = {};
  for (const i of items) {
    const g = i.provenance === "weighed" ? "label" : i.provenance || "photo";
    groups[g] = (groups[g] || 0) + i.kcal;
  }
  return Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .map(([g, k]) => `${g} ${Math.round((k / total) * 100)}%`)
    .join(" · ");
}

function mealCard(e) {
  const div = document.createElement("div");
  div.className = "card meal";
  const unresolved = e.items.some((i) => i.unresolved);
  const provCounts = {};
  for (const i of e.items) provCounts[i.provenance || "photo"] = (provCounts[i.provenance || "photo"] || 0) + i.kcal;
  const prov = Object.entries(provCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "photo";
  div.innerHTML = `
    <div class="m-info">
      <div class="m-name">${e.time} — ${e.items.map((i) => esc(i.name)).join(", ")}</div>
      <div class="m-macros">P ${Math.round(e.totals.protein_g)}g · C ${Math.round(e.totals.carbs_g)}g · F ${Math.round(e.totals.fat_g)}g
        <span class="chip ${prov}">${prov}</span>${unresolved ? ' <span class="dot-unresolved">●</span>' : ""}</div>
    </div>
    <div class="m-kcal">${e.totals.kcal} kcal</div>
    <button class="del" title="Delete meal">✕</button>`;
  div.querySelector(".m-info").addEventListener("click", () => openEntryForEdit(e));
  div.querySelector(".del").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!confirm("Delete this meal?")) return;
    await Data.log.del(e.id);
    log = log.filter((x) => x.id !== e.id);
    renderToday();
  });
  return div;
}

function renderWeightCard() {
  const s = activeSeries();
  const onDate = weights.find((w) => w.date === logDate);
  $("#weight-label").textContent = onDate ? "Weight ✓" : "Morning weight";
  $("#f-morning-weight").value = onDate ? onDate.kg : "";
  let trend = "";
  if (s) {
    const sw = seriesWeights(s);
    if (sw.length >= 2) {
      const win = sw.filter((w) => daysBetween(w.date, todayStr()) < 14);
      const smooth = rollingMean7(win.length >= 2 ? win : sw);
      const last = smooth[smooth.length - 1];
      const perWeek = linearFitSlope(smooth) * 7;
      trend = `7d avg ${r1(last.kg)} kg · ${perWeek >= 0 ? "+" : ""}${r1(perWeek * 10) / 10} kg/wk · ${sw.length} weigh-ins (${esc(s.name)})`;
    } else {
      trend = `${sw.length} weigh-in${sw.length === 1 ? "" : "s"} in "${esc(s.name)}" — trend from day 2`;
    }
  } else {
    trend = "First weigh-in starts your series.";
  }
  $("#weight-trend").innerHTML = trend;
}

$("#save-weight-btn").addEventListener("click", async () => {
  const kg = Number($("#f-morning-weight").value);
  if (!kg || kg < 30) return;
  let s = seriesForDate(logDate);
  if (!s) {
    s = { id: Data.newId(), name: "Scale", start: logDate, legacy: false };
    await Data.series.put(s);
    series.push(s);
  }
  const w = { date: logDate, kg, series: s.id };
  await Data.weights.put(w);
  weights = weights.filter((x) => x.date !== w.date).concat(w);
  renderToday();
});

$("#new-series-btn").addEventListener("click", async () => {
  const name = prompt("Name for the new series (e.g. Norway, new scale):");
  if (!name) return;
  const s = { id: Data.newId(), name, start: todayStr(), legacy: false };
  await Data.series.put(s);
  series.push(s);
  renderToday();
});

function renderBackupNag() {
  const last = Number(localStorage.getItem("caltrack_last_backup") || 0);
  const stale = !last || Date.now() - last > 14 * 86400000;
  $("#backup-nag").hidden = !stale || log.length === 0;
}

// ---------- scan / review ----------
function startScanView() {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  $("#view-scan").hidden = false;
  $("#scan-result").hidden = true;
  $("#question-banner").hidden = true;
  scanRevisions = [];
  $("#revise-summary").textContent = "";
  $("#revise-input").value = "";
  $("#question-answer").value = "";
}

function setScanBusy(text) {
  $("#scan-status-text").textContent = text;
  $("#scan-status").hidden = false;
}

async function fileToResized(file, maxDim) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataUrl, base64: dataUrl.split(",")[1] };
}

$("#photo-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const { dataUrl, base64 } = await fileToResized(file, 1024);
  $("#scan-preview").src = dataUrl;
  startScanView();
  setScanBusy("Analyzing your meal…");
  try {
    const result = await LLM.analyzePhoto(base64);
    scanItems = (result.items || []).map((i) => {
      const est = {
        portion_g: i.portion_g, kcal: i.kcal, kcal_low: i.kcal_low, kcal_high: i.kcal_high,
        protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g,
      };
      const unc = i.kcal > 0 ? r1(Math.max(0.05, (i.kcal_high - i.kcal_low) / (2 * i.kcal))) : UNC.photo;
      return {
        name: i.name, grams: Math.round(i.portion_g),
        base: { portion_g: i.portion_g, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g },
        est, provenance: "photo", unc, unresolved: !!i.hidden_factor,
        hidden_factor: i.hidden_factor || null, food_id: null, source: "model",
      };
    });
    scanQuestion = result.question || null;
    $("#scan-notes").textContent = result.notes || "";
    if (!scanItems.length) $("#scan-notes").textContent = result.notes || "No food detected — add items manually or cancel.";
  } catch (e) {
    alert("Analysis failed: " + e.message);
    scanItems = [];
    scanQuestion = null;
    $("#scan-notes").textContent = "Analysis failed — you can add items manually.";
  }
  $("#scan-status").hidden = true;
  openReview();
});

$("#label-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const { base64 } = await fileToResized(file, 1600);
  $("#scan-preview").src = "";
  startScanView();
  setScanBusy("Reading the label…");
  try {
    const r = await LLM.analyzeLabel(base64);
    $("#scan-status").hidden = true;
    if (!r.per_100g || !r.per_100g.kcal) {
      alert("Could not read a label: " + (r.notes || "unknown"));
      showView("today");
      return;
    }
    const msg = `${r.name}\n${r.per_100g.kcal} kcal / 100g · P ${r.per_100g.protein_g} · C ${r.per_100g.carbs_g} · F ${r.per_100g.fat_g}` +
      (r.unit_g ? `\nUnit: ${r.unit_g} g` : "") + (r.notes ? `\n(${r.notes})` : "");
    if (confirm(`Save to foods?\n\n${msg}`)) {
      const aliases = (prompt("Aliases (comma-separated, optional):") || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const food = {
        id: Data.newId(), name: r.name, aliases, per_100g: r.per_100g,
        basis: "label", unc: UNC.label, note: `label photo ${todayStr()}`,
        default_g: r.unit_g || 100, last_used: todayStr(),
      };
      await Data.foods.put(food);
      foods.push(food);
      if (confirm("Also log it now?")) {
        scanItems = [foodToScanItem(food, food.default_g)];
        scanQuestion = null;
        $("#scan-notes").textContent = "";
        openReview();
        return;
      }
    }
    showView("today");
  } catch (e) {
    $("#scan-status").hidden = true;
    alert("Label reading failed: " + e.message);
    showView("today");
  }
});

function foodToScanItem(food, grams) {
  const per = food.per_100g;
  const f = grams / 100;
  const provenance = food.basis === "label" ? "label" : food.basis === "recipe" ? "weighed" : "recalled";
  return {
    name: food.name, grams,
    base: { portion_g: grams, kcal: per.kcal * f, protein_g: per.protein_g * f, carbs_g: per.carbs_g * f, fat_g: per.fat_g * f },
    est: null, provenance, unc: food.unc ?? UNC[provenance],
    unresolved: false, hidden_factor: null, food_id: food.id, source: "db",
  };
}

// ---------- loose-text entry ----------
// Most-recently-used first, capped so the per-call cost can't creep upward.
function foodsDigest() {
  return foods
    .slice().sort((a, b) => ((b.last_used || "") < (a.last_used || "") ? -1 : 1))
    .slice(0, 100)
    .map((f) => `${f.id} | ${f.name} | ${(f.aliases || []).join(",")} | ${f.per_100g.kcal} kcal/100g | ${f.default_g || 100}`)
    .join("\n") || "(empty)";
}

$("#text-entry-btn").addEventListener("click", async () => {
  const text = $("#text-entry-input").value.trim();
  if (!text) return;
  $("#scan-preview").src = "";
  startScanView();
  setScanBusy("Working out what you ate…");
  try {
    const digest = foodsDigest();
    const cutoff = dateNDaysAgo(14);
    const recent = log
      .filter((e) => e.date >= cutoff && !e.items.every((i) => i.provenance === "legacy"))
      .flatMap((e) => e.items.map((i) => `${e.date}: ${i.name} (${Math.round(i.kcal)} kcal)`));
    const recentDigest = [...new Set(recent)].slice(-60).join("\n") || "(none)";

    const r = await LLM.parseText(text, digest || "(empty)", recentDigest);
    scanItems = [];
    for (const it of r.items || []) {
      if (it.kind === "food" && it.food_id) {
        const food = foods.find((f) => f.id === it.food_id);
        if (food) { scanItems.push(foodToScanItem(food, Math.round(it.grams || food.default_g || 100))); continue; }
      }
      if (it.kind === "log_ref" && it.date && it.item_name) {
        const src = logRefLookup(it.date, it.item_name);
        if (src) {
          scanItems.push({
            name: src.name, grams: Math.round(it.grams || src.portion_g),
            base: { portion_g: src.portion_g, kcal: src.kcal, protein_g: src.protein_g, carbs_g: src.carbs_g, fat_g: src.fat_g },
            est: src.est || null, provenance: src.provenance || "recalled", unc: src.unc ?? UNC.recalled,
            unresolved: false, hidden_factor: null, food_id: src.food_id || null, source: "log",
          });
          continue;
        }
      }
      // estimate (or fallback when a reference didn't resolve)
      const grams = Math.round(it.grams || 100);
      const kcal = it.kcal || 0;
      scanItems.push({
        name: it.name || it.item_name || "Item", grams,
        base: { portion_g: grams, kcal, protein_g: it.protein_g || 0, carbs_g: it.carbs_g || 0, fat_g: it.fat_g || 0 },
        est: kcal ? { portion_g: grams, kcal, kcal_low: it.kcal_low ?? kcal * 0.6, kcal_high: it.kcal_high ?? kcal * 1.4, protein_g: it.protein_g || 0, carbs_g: it.carbs_g || 0, fat_g: it.fat_g || 0 } : null,
        provenance: "recalled", unc: UNC.recalled, unresolved: false,
        hidden_factor: null, food_id: null, source: "model",
      });
    }
    scanQuestion = r.question || null;
    $("#scan-notes").textContent = "";
    $("#scan-status").hidden = true;
    if (!scanItems.length) {
      alert("Could not turn that into any items — try rephrasing.");
      showView("today");
      return;
    }
    $("#text-entry-input").value = "";
    openReview();
  } catch (e) {
    $("#scan-status").hidden = true;
    alert("Text entry failed: " + e.message);
    showView("today");
  }
});

function logRefLookup(date, itemName) {
  const needle = itemName.toLowerCase();
  for (const e of log.filter((x) => x.date === date)) {
    for (const i of e.items) {
      if (i.name.toLowerCase() === needle || i.name.toLowerCase().includes(needle) || needle.includes(i.name.toLowerCase())) return i;
    }
  }
  return null;
}

// ---------- review UI ----------
function openReview() {
  $("#scan-status").hidden = true;
  $("#scan-result").hidden = false;
  if (scanQuestion) {
    $("#question-text").textContent = scanQuestion;
    $("#question-banner").hidden = false;
  } else {
    $("#question-banner").hidden = true;
  }
  $("#save-meal-btn").textContent = editingEntryId ? "Update meal" : "Save meal";
  fillFoodDatalist();
  renderScanItems();
}

$("#looks-right-btn").addEventListener("click", () => {
  scanItems.forEach((it) => (it.unresolved = false));
  scanQuestion = null;
  $("#question-banner").hidden = true;
  renderScanItems();
});

// Apply a spoken correction ("3 eggs not 4", "a tablespoon of butter", "the ham
// is my saved one"). The user's statement is authoritative — they were there.
async function reviseScan(instruction) {
  const text = (instruction || "").trim();
  if (!text) return;
  const before = entryTotals(scanItems.map(itemMacros)).kcal;
  const prevByName = new Map(scanItems.map((it) => [it.name.trim().toLowerCase(), it]));
  const snapshot = scanItems.map((it) => {
    const m = itemMacros(it);
    return {
      name: it.name, grams: it.grams, kcal: m.kcal,
      protein_g: r1(m.protein_g), carbs_g: r1(m.carbs_g), fat_g: r1(m.fat_g),
      food_id: it.food_id,
    };
  });

  $("#scan-result").hidden = true;
  setScanBusy("Applying your correction…");
  try {
    const r = await LLM.reviseItems(snapshot, text, foodsDigest());
    const revised = [];
    for (const it of r.items || []) {
      const prev = prevByName.get((it.name || "").trim().toLowerCase());
      if (it.kind === "food" && it.food_id) {
        const food = foods.find((f) => f.id === it.food_id);
        if (food) {
          const si = foodToScanItem(food, Math.round(it.grams || food.default_g || 100));
          si.est = prev ? prev.est : null; // keep the original estimate so the ledger sees the swap
          revised.push(si);
          continue;
        }
      }
      const pm = prev ? itemMacros(prev) : null;
      const grams = Math.round(it.grams || (prev ? prev.grams : 100));
      const kcal = it.kcal != null ? it.kcal : pm ? pm.kcal : 0;
      const fresh = it.kcal != null
        ? {
            portion_g: grams, kcal,
            kcal_low: it.kcal_low != null ? it.kcal_low : kcal * 0.75,
            kcal_high: it.kcal_high != null ? it.kcal_high : kcal * 1.25,
            protein_g: it.protein_g || 0, carbs_g: it.carbs_g || 0, fat_g: it.fat_g || 0,
          }
        : null;
      revised.push({
        name: it.name || (prev ? prev.name : "Item"), grams,
        base: {
          portion_g: grams, kcal,
          protein_g: it.protein_g != null ? it.protein_g : pm ? pm.protein_g : 0,
          carbs_g: it.carbs_g != null ? it.carbs_g : pm ? pm.carbs_g : 0,
          fat_g: it.fat_g != null ? it.fat_g : pm ? pm.fat_g : 0,
        },
        // an item that already existed keeps its ORIGINAL estimate, so a quantity
        // correction is recorded against what the model first claimed
        est: prev && prev.est ? prev.est : fresh,
        provenance: prev ? prev.provenance : "photo",
        unc: prev ? prev.unc : UNC.photo,
        unresolved: false, hidden_factor: null,
        food_id: null, source: prev ? prev.source : "model",
      });
    }
    if (!revised.length) throw new Error("the revision returned no items");
    scanItems = revised;
    const after = entryTotals(scanItems.map(itemMacros)).kcal;
    scanRevisions.push({ from: before, to: after, instruction: text });
    scanQuestion = r.question || null;
    $("#revise-summary").textContent =
      `${r.summary || "Revised."} (${before} → ${after} kcal)`;
    $("#revise-input").value = "";
    $("#question-answer").value = "";
  } catch (e) {
    alert("Revision failed: " + e.message);
  }
  $("#scan-status").hidden = true;
  openReview();
}

$("#answer-question-btn").addEventListener("click", () => reviseScan($("#question-answer").value));
$("#revise-btn").addEventListener("click", () => reviseScan($("#revise-input").value));
$("#question-answer").addEventListener("keydown", (e) => { if (e.key === "Enter") reviseScan(e.target.value); });
$("#revise-input").addEventListener("keydown", (e) => { if (e.key === "Enter") reviseScan(e.target.value); });

function itemMacros(it) {
  const f = it.base.portion_g > 0 ? it.grams / it.base.portion_g : 1;
  return {
    kcal: it.base.kcal * f,
    protein_g: it.base.protein_g * f,
    carbs_g: it.base.carbs_g * f,
    fat_g: it.base.fat_g * f,
  };
}
// Mirrors savedItemRange: keep the model's interval only while the item still
// matches its estimate (same 2% threshold the correction ledger uses).
function itemRange(it) {
  const m = itemMacros(it);
  if (it.est && it.est.kcal > 0 && it.est.portion_g > 0) {
    const f = it.grams / it.est.portion_g;
    const scaled = it.est.kcal * f;
    if (scaled > 0 && Math.abs(m.kcal - scaled) / scaled <= 0.02) {
      return [it.est.kcal_low * f, it.est.kcal_high * f];
    }
  }
  return [m.kcal * (1 - it.unc), m.kcal * (1 + it.unc)];
}

function fillFoodDatalist() {
  $("#food-names").innerHTML = foods.map((f) => `<option value="${esc(f.name)}">`).join("");
}

function findFoodMatch(name) {
  const n = name.trim().toLowerCase();
  if (n.length < 3) return null;
  let best = null;
  for (const f of foods) {
    const names = [f.name.toLowerCase(), ...(f.aliases || []).map((a) => a.toLowerCase())];
    if (names.some((x) => x === n)) return f;
    if (!best && names.some((x) => x.includes(n) || n.includes(x))) best = f;
  }
  return best;
}

function renderScanItems() {
  const wrap = $("#scan-items");
  wrap.innerHTML = "";
  scanItems.forEach((it, idx) => {
    const m = itemMacros(it);
    const match = it.food_id ? null : findFoodMatch(it.name);
    const div = document.createElement("div");
    div.className = "card item-card";
    div.innerHTML = `
      <div class="item-head">
        <input type="text" value="${esc(it.name)}" data-f="name" list="food-names" />
        <select class="prov-select" data-f="prov">
          ${["label", "weighed", "photo", "recalled", "legacy"].map((p) => `<option value="${p}" ${p === it.provenance ? "selected" : ""}>${p}</option>`).join("")}
        </select>
        <button class="del" title="Remove">✕</button>
      </div>
      ${match ? `<button class="chip match" data-f="match">use saved: ${match.per_100g.kcal} kcal/100g</button>` : ""}
      <select class="link-food ${it.food_id ? "linked" : ""}" data-f="linkfood">
        <option value="">🔗 link a saved food…</option>
        ${foods.slice().sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => `<option value="${f.id}" ${f.id === it.food_id ? "selected" : ""}>${esc(f.name)} — ${f.per_100g.kcal}/100g</option>`)
          .join("")}
      </select>
      ${it.hidden_factor && it.unresolved ? `<div class="badge-hidden" data-f="hidden">● ${esc(it.hidden_factor)} — tap when resolved</div>` : ""}
      <div class="item-macros">
        <label>g <input type="number" min="0" value="${it.grams}" data-f="grams" /></label>
        <label>kcal <input type="number" min="0" value="${Math.round(m.kcal)}" data-f="kcal" /></label>
        <label>P <input type="number" min="0" step="0.1" value="${r1(m.protein_g)}" data-f="protein_g" /></label>
        <label>C <input type="number" min="0" step="0.1" value="${r1(m.carbs_g)}" data-f="carbs_g" /></label>
        <label>F <input type="number" min="0" step="0.1" value="${r1(m.fat_g)}" data-f="fat_g" /></label>
      </div>
      <div class="item-actions">
        <button class="linkish tiny" data-f="tofoods">Save to foods</button>
      </div>`;

    div.querySelector('[data-f="name"]').addEventListener("input", (e) => {
      it.name = e.target.value;
      it.food_id = null;
    });
    div.querySelector('[data-f="name"]').addEventListener("change", () => renderScanItems());
    div.querySelector('[data-f="prov"]').addEventListener("change", (e) => {
      it.provenance = e.target.value;
      it.unc = UNC[it.provenance] ?? it.unc;
    });
    // Linking a saved food replaces a guess with label data. `est` is kept so the
    // substitution is still recorded in the ledger as a db-match.
    const applyFood = (food) => {
      const applied = foodToScanItem(food, it.grams);
      Object.assign(it, applied, {
        grams: it.grams, est: it.est, hidden_factor: it.hidden_factor, unresolved: false,
      });
      renderScanItems();
    };
    const matchBtn = div.querySelector('[data-f="match"]');
    if (matchBtn) matchBtn.addEventListener("click", () => {
      const food = findFoodMatch(it.name);
      if (food) applyFood(food);
    });
    div.querySelector('[data-f="linkfood"]').addEventListener("change", (e) => {
      const food = foods.find((f) => f.id === e.target.value);
      if (!food) { it.food_id = null; renderScanItems(); return; }
      applyFood(food);
    });
    const hiddenBadge = div.querySelector('[data-f="hidden"]');
    if (hiddenBadge) hiddenBadge.addEventListener("click", () => {
      it.unresolved = false;
      renderScanItems();
    });
    div.querySelector('[data-f="grams"]').addEventListener("change", (e) => {
      it.grams = Number(e.target.value) || 0;
      renderScanItems();
    });
    // editing a macro directly re-anchors the baseline at current grams
    for (const f of ["kcal", "protein_g", "carbs_g", "fat_g"]) {
      div.querySelector(`[data-f="${f}"]`).addEventListener("change", (e) => {
        const m2 = itemMacros(it);
        it.base = { portion_g: it.grams, kcal: m2.kcal, protein_g: m2.protein_g, carbs_g: m2.carbs_g, fat_g: m2.fat_g };
        it.base[f] = Number(e.target.value) || 0;
        renderScanItems();
      });
    }
    div.querySelector('[data-f="tofoods"]').addEventListener("click", async () => {
      await saveItemToFoods(it);
      renderScanItems();
    });
    div.querySelector(".del").addEventListener("click", () => {
      scanItems.splice(idx, 1);
      renderScanItems();
    });
    wrap.appendChild(div);
  });

  const totals = entryTotals(scanItems.map((it) => itemMacros(it)));
  const [lo, hi] = scanItems.reduce(([a, b], it) => {
    const [l, h] = itemRange(it);
    return [a + l, b + h];
  }, [0, 0]);
  $("#scan-totals").innerHTML = `
    <div><b>${totals.kcal}</b>kcal<span class="hint range-sub">${Math.round(lo)}–${Math.round(hi)}</span></div>
    <div><b>${Math.round(totals.protein_g)}g</b>protein</div>
    <div><b>${Math.round(totals.carbs_g)}g</b>carbs</div>
    <div><b>${Math.round(totals.fat_g)}g</b>fat</div>`;
  $("#save-meal-btn").disabled = scanItems.length === 0;
  $("#save-recipe-btn").hidden = scanItems.length < 2;
}

async function saveItemToFoods(it) {
  const m = itemMacros(it);
  if (!it.grams || !m.kcal) { alert("Need grams and kcal first."); return; }
  const f = 100 / it.grams;
  const aliases = (prompt(`Save "${it.name}" to foods.\nAliases (comma-separated, optional):`) || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const basis = it.provenance === "label" || it.provenance === "weighed" ? "label" : "estimate";
  const food = {
    id: Data.newId(), name: it.name.trim(), aliases,
    per_100g: { kcal: r1(m.kcal * f), protein_g: r1(m.protein_g * f), carbs_g: r1(m.carbs_g * f), fat_g: r1(m.fat_g * f) },
    basis, unc: basis === "label" ? UNC.label : 0.2,
    note: `saved from log ${todayStr()}`, default_g: it.grams, last_used: todayStr(),
  };
  await Data.foods.put(food);
  foods.push(food);
  it.food_id = food.id;
}

$("#save-recipe-btn").addEventListener("click", async () => {
  const totalG = Number(prompt("Final batch weight in grams (after cooking):"));
  if (!totalG || totalG <= 0) return;
  const name = prompt("Recipe name:", "Pancake batter");
  if (!name) return;
  const ingredients = scanItems.map((it) => {
    const m = itemMacros(it);
    return { name: it.name, food_id: it.food_id || null, grams: it.grams, kcal: r1(m.kcal), protein_g: r1(m.protein_g), carbs_g: r1(m.carbs_g), fat_g: r1(m.fat_g) };
  });
  const food = {
    id: Data.newId(), name, aliases: [], basis: "recipe",
    ingredients, total_g: totalG, per_100g: recipePer100g(ingredients, totalG),
    unc: UNC.weighed, note: `recipe ${todayStr()}`, default_g: 100, last_used: todayStr(),
  };
  await Data.foods.put(food);
  foods.push(food);
  alert(`Saved "${name}" — ${food.per_100g.kcal} kcal/100g. Log portions by weight from now on.`);
});

function addManualItem() {
  scanItems.push({
    name: "New item", grams: 100,
    base: { portion_g: 100, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    est: null, provenance: "weighed", unc: UNC.weighed,
    unresolved: false, hidden_factor: null, food_id: null, source: "manual",
  });
  renderScanItems();
}
$("#add-item-btn").addEventListener("click", addManualItem);

$("#manual-meal-btn").addEventListener("click", () => {
  $("#scan-preview").src = "";
  scanItems = [];
  scanQuestion = null;
  editingEntryId = null;
  editingPrevItems = null;
  startScanView();
  $("#scan-notes").textContent = "";
  openReview();
  addManualItem();
});

function openEntryForEdit(e) {
  editingEntryId = e.id;
  editingPrevItems = JSON.parse(JSON.stringify(e.items));
  scanItems = e.items.map((i) => ({
    name: i.name, grams: i.portion_g,
    base: { portion_g: i.portion_g, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g },
    est: i.est || null, provenance: i.provenance || "photo", unc: i.unc ?? UNC.photo,
    unresolved: !!i.unresolved, hidden_factor: i.hidden_factor || null,
    food_id: i.food_id || null, source: "model",
  }));
  scanQuestion = null;
  $("#scan-preview").src = "";
  startScanView();
  $("#scan-notes").textContent = "";
  openReview();
}

// ---------- save ----------
$("#save-meal-btn").addEventListener("click", async () => {
  const items = scanItems
    .filter((it) => it.name.trim())
    .map((it) => {
      const m = itemMacros(it);
      const saved = {
        name: it.name.trim(), portion_g: it.grams,
        kcal: Math.round(m.kcal), protein_g: r1(m.protein_g), carbs_g: r1(m.carbs_g), fat_g: r1(m.fat_g),
        provenance: it.provenance, unc: it.unc, unresolved: !!it.unresolved,
        corrected: false, food_id: it.food_id || null, hidden_factor: it.hidden_factor || null,
        est: it.est || null,
      };
      return { saved, meta: it };
    });
  if (!items.length) return;

  const now = new Date();
  const entryId = editingEntryId || Data.newId();

  // correction ledger
  const toRecord = [];
  if (editingEntryId && editingPrevItems) {
    for (let i = 0; i < Math.min(items.length, editingPrevItems.length); i++) {
      const prev = editingPrevItems[i], cur = items[i].saved;
      if (prev.kcal > 0 && Math.abs(cur.kcal - prev.kcal) / prev.kcal > 0.02) {
        toRecord.push({ ts: now.toISOString(), entry_id: entryId, item: cur.name, kcal_from: prev.kcal, kcal_to: cur.kcal, phase: "post-save" });
        cur.corrected = true;
      }
    }
  } else {
    for (const { saved, meta } of items) {
      if (!meta.est || !meta.est.portion_g) continue;
      const scaled = meta.est.kcal * (saved.portion_g / meta.est.portion_g);
      if (!(scaled > 0)) continue;
      if (Math.abs(saved.kcal - scaled) / scaled <= 0.02) continue;
      const isDbMatch = meta.source === "db";
      // A spoken revision is recorded once at entry level below. Logging the
      // per-item deviation as well would count the same decision twice.
      if (scanRevisions.length && !isDbMatch) continue;
      toRecord.push({
        ts: now.toISOString(), entry_id: entryId, item: saved.name,
        kcal_from: Math.round(scaled), kcal_to: saved.kcal,
        phase: isDbMatch ? "db-match" : "review",
      });
      saved.corrected = true;
    }
    // Spoken corrections: one record each, carrying what was actually said.
    // Quantity changes ("3 eggs not 4") scale est with the portion and so are
    // invisible to the per-item check above — this is what catches them.
    for (const rev of scanRevisions) {
      if (rev.from > 0 && Math.abs(rev.to - rev.from) / rev.from > 0.02) {
        toRecord.push({
          ts: now.toISOString(), entry_id: entryId, item: rev.instruction.slice(0, 80),
          kcal_from: rev.from, kcal_to: rev.to, phase: "revision",
        });
      }
    }
  }
  for (const c of toRecord) { await Data.corrections.add(c); corrections.push(c); }

  // bump last_used on referenced foods
  for (const { saved } of items) {
    if (!saved.food_id) continue;
    const food = foods.find((f) => f.id === saved.food_id);
    if (food) { food.last_used = todayStr(); await Data.foods.put(food); }
  }

  const plainItems = items.map((x) => x.saved);
  let entry;
  if (editingEntryId) {
    const old = log.find((e) => e.id === editingEntryId);
    entry = { ...old, items: plainItems, totals: entryTotals(plainItems) };
  } else {
    entry = {
      id: entryId, date: logDate,
      time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      items: plainItems, totals: entryTotals(plainItems),
    };
  }
  await Data.log.put(entry);
  log = log.filter((e) => e.id !== entry.id).concat(entry);
  editingEntryId = null;
  editingPrevItems = null;
  scanRevisions = [];
  showView("today");
});

$("#cancel-scan-btn").addEventListener("click", () => {
  editingEntryId = null;
  editingPrevItems = null;
  showView("today");
});

// ---------- history ----------
function renderHistory() {
  // weight card
  const s = activeSeries();
  let wHtml = "<h2>Weight</h2>";
  if (s) {
    const sw = seriesWeights(s);
    if (sw.length >= 2) {
      const smooth = rollingMean7(sw);
      const last = smooth[smooth.length - 1];
      const recent = smooth.filter((p) => daysBetween(p.date, todayStr()) < 14);
      const perWeek = linearFitSlope(recent.length >= 2 ? recent : smooth) * 7;
      wHtml += `<p><b>${r1(last.kg)} kg</b> smoothed · ${perWeek >= 0 ? "+" : ""}${Math.round(perWeek * 100) / 100} kg/week</p>
        <p class="hint">${sw.length} weigh-ins in "${esc(s.name)}" since ${s.start}</p>`;
    } else {
      wHtml += `<p class="hint">"${esc(s.name)}" started ${s.start} — ${sw.length} weigh-in(s) so far.</p>`;
    }
  } else {
    wHtml += `<p class="hint">No active weight series yet — log a morning weight on Today.</p>`;
  }
  const legacy = series.filter((x) => x.legacy);
  if (legacy.length) wHtml += `<p class="hint">${legacy.map((l) => esc(l.name)).join(", ")}: legacy, excluded from trend.</p>`;
  $("#hist-weight-card").innerHTML = wHtml;

  // TDEE card
  renderTdeeCard();

  // corrections asymmetry
  const judged = corrections.filter((c) => c.phase === "review" || c.phase === "post-save" || c.phase === "revision");
  const dbm = corrections.filter((c) => c.phase === "db-match").length;
  if (judged.length) {
    const down = judged.filter((c) => c.kcal_to < c.kcal_from).length;
    const up = judged.length - down;
    const net = judged.reduce((sum, c) => sum + (c.kcal_to - c.kcal_from), 0);
    let line = `${judged.length} corrections: ${net >= 0 ? "+" : ""}${net} kcal net, ${down} down / ${up} up`;
    if (judged.length >= 5 && (down === 0 || up === 0)) line += " — one-directional: check for bias";
    if (dbm) line += ` (+${dbm} db substitutions, excluded)`;
    $("#hist-corrections").textContent = line;
    $("#hist-corrections").hidden = false;
  } else {
    $("#hist-corrections").hidden = true;
  }

  // day rows
  const wrap = $("#history-days");
  wrap.innerHTML = "";
  const days = [];
  for (let i = 0; i < 14; i++) days.push(dateNDaysAgo(i));
  const logged = days.filter((d) => dayEntries(d).length);
  if (!logged.length) wrap.innerHTML = `<div class="empty">No history yet.</div>`;
  for (const d of logged) {
    const t = dayTotals(d);
    const [lo, hi] = dayRange(d);
    const target = kcalTargetFor(d);
    const kcalOk = t.kcal <= target;
    const protOk = !profile?.protein_target || t.protein_g >= profile.protein_target;
    const div = document.createElement("div");
    div.className = "card day";
    div.innerHTML = `
      <div class="day-head">
        <span>${d === todayStr() ? "Today" : d}</span>
        <span><span class="${kcalOk ? "ok" : "miss"}">${t.kcal} kcal</span> / ${target} · <span class="${protOk ? "ok" : "miss"}">${Math.round(t.protein_g)}g P</span></span>
      </div>
      <div class="stat-sub"><span class="range-sub">${Math.round(lo)}–${Math.round(hi)}</span> · ${tierLine(d)}</div>
      <div class="day-meals" hidden></div>`;
    const meals = div.querySelector(".day-meals");
    div.addEventListener("click", () => {
      if (meals.hidden) {
        meals.innerHTML = dayEntries(d)
          .map((e) => `<div class="meal"><div class="m-info"><div class="m-name">${e.time} — ${e.items.map((i) => esc(i.name)).join(", ")}</div></div><div class="m-kcal">${e.totals.kcal} kcal</div></div>`)
          .join("");
      }
      meals.hidden = !meals.hidden;
    });
    wrap.appendChild(div);
  }
}

function tdeeInput() {
  const s = activeSeries();
  const intakeDays = [];
  for (let i = 0; i < 14; i++) {
    const d = dateNDaysAgo(i);
    if (dayEntries(d).length && !isLegacyOnly(d)) intakeDays.push({ date: d, kcal: dayTotals(d).kcal });
  }
  return {
    today: todayStr(),
    seriesStart: s ? s.start : null,
    weights: s ? seriesWeights(s) : [],
    intakeDays,
    tdee: profile?.tdee ?? null,
    tdeeUpdated: profile?.tdee_updated ?? null,
  };
}

function renderTdeeCard() {
  const card = $("#hist-tdee-card");
  const sug = tdeeSuggestion(tdeeInput());
  const current = profile?.tdee ? `<p><b>TDEE ${profile.tdee} kcal</b>${profile.tdee_updated ? ` <span class="hint">(set ${profile.tdee_updated})</span>` : ""}</p>` : `<p class="hint">No TDEE set yet — set one in Settings or wait for the weight trend.</p>`;
  let body = "";
  if (sug.status === "settling") body = `<p class="hint">Weight series settling — revisions start 12 days after the series began.</p>`;
  else if (sug.status === "insufficient-weights") body = `<p class="hint">Need ≥10 weigh-ins in the last 14 days for a revision.</p>`;
  else if (sug.status === "insufficient-intake") body = `<p class="hint">Need ≥10 logged days in the last 14 for a revision.</p>`;
  else if (sug.status === "too-soon") body = `<p class="hint">Implied ~${sug.implied} kcal. Next revision unlocks 7 days after the last one.</p>`;
  else if (sug.status === "ready") {
    const d = sug.delta;
    body = `<p>Weight trend implies <b>~${sug.implied} kcal</b>${sug.confidence ? ` <span class="hint">(${sug.confidence} confidence)</span>` : ""}.</p>
      <button class="btn small primary" id="apply-tdee-btn">${sug.first ? `Set TDEE to ${sug.suggested}` : `Apply ${d >= 0 ? "+" : ""}${d} → ${sug.suggested}`}</button>`;
  }
  card.innerHTML = `<h2>Maintenance (TDEE)</h2>${current}${body}`;
  const btn = $("#apply-tdee-btn");
  if (btn) btn.addEventListener("click", async () => {
    const before = profile.tdee;
    profile.tdee = sug.suggested;
    profile.tdee_updated = todayStr();
    profile.tdee_history = profile.tdee_history || [];
    profile.tdee_history.push({ date: todayStr(), tdee: sug.suggested, basis: "weight-trend", implied: sug.implied });
    if (before && sug.delta && confirm(`Also shift all 7 weekday targets by ${sug.delta >= 0 ? "+" : ""}${sug.delta} kcal?`)) {
      profile.kcal_targets = profile.kcal_targets.map((t) => t + sug.delta);
    }
    await Data.saveProfile(profile);
    renderHistory();
  });
}

// ---------- settings ----------
const WEEKDAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];

function renderSettings() {
  if (!$("#recipe-builder").hidden) closeRecipeBuilder();
  // API key
  const key = localStorage.getItem("caltrack_api_key");
  $("#key-status").textContent = key ? `Key saved (…${key.slice(-4)})` : "No key yet — LLM features disabled until you add one.";

  // weekday targets
  const grid = $("#weekday-targets");
  grid.innerHTML = WEEKDAYS.map(([label, idx]) =>
    `<label>${label}<input type="number" data-day="${idx}" min="800" max="6000" value="${(profile?.kcal_targets || DEFAULT_TARGETS)[idx]}" /></label>`
  ).join("");
  $("#f-prot-target").value = profile?.protein_target ?? 160;
  $("#f-tdee").value = profile?.tdee ?? "";
  if (profile?.mifflin) {
    $("#f-weight").value = profile.mifflin.weight || "";
    $("#f-height").value = profile.mifflin.height || "";
    $("#f-age").value = profile.mifflin.age || "";
    $("#f-sex").value = profile.mifflin.sex || "male";
    $("#f-activity").value = profile.mifflin.activity || "1.55";
  }

  renderFoodsList();
  renderSeriesList();

  const last = Number(localStorage.getItem("caltrack_last_backup") || 0);
  $("#last-backup-line").textContent = last ? `Last backup: ${new Date(last).toLocaleDateString()}` : "No backup yet — data lives only on this phone.";
}

$("#save-key-btn").addEventListener("click", () => {
  const v = $("#f-api-key").value.trim();
  if (!v) return;
  localStorage.setItem("caltrack_api_key", v);
  $("#f-api-key").value = "";
  renderSettings();
});

$("#mifflin-btn").addEventListener("click", () => {
  const w = Number($("#f-weight").value), h = Number($("#f-height").value), a = Number($("#f-age").value);
  const sex = $("#f-sex").value, act = Number($("#f-activity").value);
  if (!w || !h || !a) { $("#mifflin-out").textContent = "Fill weight, height, age."; return; }
  const bmr = 10 * w + 6.25 * h - 5 * a + (sex === "male" ? 5 : -161);
  const tdee = Math.round(bmr * act);
  $("#mifflin-out").textContent = ` ≈ ${tdee} kcal`;
  if (!$("#f-tdee").value) $("#f-tdee").value = tdee;
});

$("#save-profile-btn").addEventListener("click", async () => {
  const targets = (profile?.kcal_targets || DEFAULT_TARGETS).slice();
  document.querySelectorAll("#weekday-targets input").forEach((inp) => {
    targets[Number(inp.dataset.day)] = Number(inp.value) || targets[Number(inp.dataset.day)];
  });
  const tdeeVal = Number($("#f-tdee").value) || null;
  const hadTdee = profile?.tdee;
  profile = {
    ...(profile || {}),
    kcal_targets: targets,
    protein_target: Number($("#f-prot-target").value) || 160,
    tdee: tdeeVal,
    tdee_updated: tdeeVal && tdeeVal !== hadTdee ? todayStr() : profile?.tdee_updated ?? null,
    tdee_history: profile?.tdee_history || [],
    mifflin: {
      weight: Number($("#f-weight").value) || null, height: Number($("#f-height").value) || null,
      age: Number($("#f-age").value) || null, sex: $("#f-sex").value, activity: $("#f-activity").value,
    },
  };
  if (tdeeVal && tdeeVal !== hadTdee) {
    profile.tdee_history.push({ date: todayStr(), tdee: tdeeVal, basis: profile.tdee_history.length ? "manual" : "mifflin" });
  }
  await Data.saveProfile(profile);
  $("#settings-saved").hidden = false;
  setTimeout(() => ($("#settings-saved").hidden = true), 1500);
});

// ---------- recipe builder: combine saved ingredients into one food ----------
let rbIngredients = [];

function openRecipeBuilder() {
  rbIngredients = [];
  $("#rb-name").value = "";
  $("#rb-grams").value = "";
  $("#rb-total").value = "";
  delete $("#rb-total").dataset.touched;
  $("#rb-custom-name").value = "";
  $("#rb-custom-grams").value = "";
  ["#rb-m-kcal", "#rb-m-p", "#rb-m-c", "#rb-m-f"].forEach((sel) => ($(sel).value = ""));
  $("#rb-manual").hidden = true;
  $("#rb-manual-toggle").textContent = "or type the values myself";
  $("#recipe-builder").hidden = false;
  $("#new-recipe-btn").hidden = true;
  renderRecipeBuilder();
}
function closeRecipeBuilder() {
  rbIngredients = [];
  $("#recipe-builder").hidden = true;
  $("#new-recipe-btn").hidden = false;
}

function renderRecipeBuilder() {
  const sel = $("#rb-food");
  const keep = sel.value;
  sel.innerHTML = foods
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `<option value="${f.id}">${esc(f.name)} — ${f.per_100g.kcal}/100g</option>`)
    .join("") || `<option value="">no saved foods yet</option>`;
  if (keep) sel.value = keep;

  const wrap = $("#rb-ingredients");
  wrap.innerHTML = rbIngredients.length
    ? ""
    : `<p class="hint">Add each ingredient by weight. Exact label data is used, so the result is exact too.</p>`;
  rbIngredients.forEach((ing, i) => {
    const row = document.createElement("div");
    row.className = "ingredient-row";
    row.innerHTML = `<span class="ing-name">${esc(ing.name)}${ing.estimated ? ' <span class="chip est">est</span>' : ""}</span>
      <span>${ing.grams} g · ${Math.round(ing.kcal)} kcal</span>
      <button class="del">✕</button>`;
    row.querySelector(".del").addEventListener("click", () => {
      rbIngredients.splice(i, 1);
      syncBatchDefault();
      renderRecipeBuilder();
    });
    wrap.appendChild(row);
  });

  const raw = rbIngredients.reduce(
    (a, i) => ({ g: a.g + i.grams, kcal: a.kcal + i.kcal, p: a.p + i.protein_g, c: a.c + i.carbs_g, f: a.f + i.fat_g }),
    { g: 0, kcal: 0, p: 0, c: 0, f: 0 }
  );
  $("#rb-totals").textContent = rbIngredients.length
    ? `Ingredients: ${Math.round(raw.g)} g · ${Math.round(raw.kcal)} kcal · P ${r1(raw.p)} C ${r1(raw.c)} F ${r1(raw.f)}`
    : "";

  const totalG = Number($("#rb-total").value) || 0;
  $("#rb-derived").textContent =
    rbIngredients.length && totalG > 0
      ? (() => {
          const per = recipePer100g(rbIngredients, totalG);
          return `Per 100 g: ${per.kcal} kcal · P ${per.protein_g} C ${per.carbs_g} F ${per.fat_g}`;
        })()
      : rbIngredients.length
        ? "Enter the finished batch weight to derive per-100g values."
        : "";
}

// Default the batch weight to the raw sum; the user lowers it for anything that
// cooks down, which is what makes later portions accurate.
function syncBatchDefault() {
  const raw = Math.round(rbIngredients.reduce((s, i) => s + i.grams, 0));
  const el = $("#rb-total");
  if (!el.dataset.touched) el.value = raw || "";
}

$("#new-recipe-btn").addEventListener("click", openRecipeBuilder);
$("#rb-cancel").addEventListener("click", closeRecipeBuilder);
// Reachable straight from Today — building a recipe is a cooking-time action,
// not a settings chore.
$("#recipe-shortcut-btn").addEventListener("click", () => {
  showView("settings");
  openRecipeBuilder();
  $("#recipe-builder").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#rb-name").focus();
});
$("#rb-manual-toggle").addEventListener("click", () => {
  const box = $("#rb-manual");
  box.hidden = !box.hidden;
  $("#rb-manual-toggle").textContent = box.hidden ? "or type the values myself" : "look it up for me instead";
});

// Ingredients that were never saved: looked up once, then optionally kept so
// they become an exact pick next time.
$("#rb-custom-add").addEventListener("click", async () => {
  const name = $("#rb-custom-name").value.trim();
  const grams = Number($("#rb-custom-grams").value);
  if (!name) return alert("Name the ingredient first.");
  if (!grams || grams <= 0) return alert("How many grams of it?");

  const manualOpen = !$("#rb-manual").hidden;
  const typedKcal = Number($("#rb-m-kcal").value);
  let per100, note = "", tidyName = name;

  if (manualOpen && typedKcal > 0) {
    per100 = {
      kcal: typedKcal,
      protein_g: Number($("#rb-m-p").value) || 0,
      carbs_g: Number($("#rb-m-c").value) || 0,
      fat_g: Number($("#rb-m-f").value) || 0,
    };
  } else if (manualOpen) {
    return alert("Enter at least kcal per 100 g, or switch back to looking it up.");
  } else {
    const btn = $("#rb-custom-add");
    const label = btn.textContent;
    btn.textContent = "…"; btn.disabled = true;
    try {
      const r = await LLM.estimateIngredient(name);
      per100 = r.per_100g;
      note = r.note || "";
      tidyName = r.name || name;
    } catch (e) {
      btn.textContent = label; btn.disabled = false;
      return alert(`Could not look that up: ${e.message}\n\nTap "or type the values myself" to enter it by hand.`);
    }
    btn.textContent = label; btn.disabled = false;
  }

  const k = grams / 100;
  rbIngredients.push({
    name: tidyName, food_id: null, grams, estimated: true,
    kcal: r1(per100.kcal * k), protein_g: r1(per100.protein_g * k),
    carbs_g: r1(per100.carbs_g * k), fat_g: r1(per100.fat_g * k),
  });

  if ($("#rb-save-ingredient").checked) {
    const food = {
      id: Data.newId(), name: tidyName, aliases: [], per_100g: per100,
      basis: "estimate", unc: 0.15,
      note: note || `reference values ${todayStr()}`,
      default_g: grams, last_used: todayStr(),
    };
    await Data.foods.put(food);
    foods.push(food);
    // keep the just-added ingredient pointing at the saved food
    rbIngredients[rbIngredients.length - 1].food_id = food.id;
  }

  $("#rb-custom-name").value = "";
  $("#rb-custom-grams").value = "";
  ["#rb-m-kcal", "#rb-m-p", "#rb-m-c", "#rb-m-f"].forEach((s) => ($(s).value = ""));
  syncBatchDefault();
  renderRecipeBuilder();
  if (note) $("#rb-derived").textContent = `Added ${tidyName} — ${note}`;
});
$("#rb-total").addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
  renderRecipeBuilder();
});
$("#rb-add").addEventListener("click", () => {
  const food = foods.find((f) => f.id === $("#rb-food").value);
  const grams = Number($("#rb-grams").value);
  if (!food) return alert("Save some foods first — scan a label, or save an item from a meal.");
  if (!grams || grams <= 0) return alert("How many grams of that ingredient?");
  const k = grams / 100;
  rbIngredients.push({
    name: food.name, food_id: food.id, grams,
    kcal: r1(food.per_100g.kcal * k), protein_g: r1(food.per_100g.protein_g * k),
    carbs_g: r1(food.per_100g.carbs_g * k), fat_g: r1(food.per_100g.fat_g * k),
  });
  $("#rb-grams").value = "";
  syncBatchDefault();
  renderRecipeBuilder();
});
$("#rb-save").addEventListener("click", async () => {
  const name = $("#rb-name").value.trim();
  const totalG = Number($("#rb-total").value);
  if (!name) return alert("Give the recipe a name.");
  if (rbIngredients.length < 2) return alert("Add at least two ingredients.");
  if (!totalG || totalG <= 0) return alert("Enter the finished batch weight.");
  // every ingredient came from the food DB, so the recipe inherits label accuracy
  const allLabelled = rbIngredients.every((i) => {
    if (i.estimated) return false;
    const f = foods.find((x) => x.id === i.food_id);
    return f && (f.basis === "label" || f.basis === "recipe");
  });
  const food = {
    id: Data.newId(), name, aliases: [], basis: "recipe",
    ingredients: rbIngredients.slice(), total_g: totalG,
    per_100g: recipePer100g(rbIngredients, totalG),
    unc: allLabelled ? UNC.weighed : 0.15,
    note: `recipe built ${todayStr()}`, default_g: 100, last_used: todayStr(),
  };
  await Data.foods.put(food);
  foods.push(food);
  closeRecipeBuilder();
  renderFoodsList();
  const per = food.per_100g;
  if (confirm(`Saved "${name}" — ${per.kcal} kcal/100 g.\n\nLog a portion of it now?`)) {
    const grams = Number(prompt(`How many grams of ${name}?`, "230"));
    if (grams > 0) {
      scanItems = [foodToScanItem(food, grams)];
      scanQuestion = null;
      editingEntryId = null;
      editingPrevItems = null;
      startScanView();
      $("#scan-notes").textContent = "";
      openReview();
    }
  }
});

let expandedFoodId = null;
function renderFoodsList() {
  const wrap = $("#foods-list");
  wrap.innerHTML = "";
  const sorted = foods.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!sorted.length) { wrap.innerHTML = `<p class="hint">No foods yet — save items from the review screen or scan a label.</p>`; return; }
  for (const f of sorted) {
    const row = document.createElement("div");
    row.className = "food-row";
    row.innerHTML = `
      <span class="f-name">${esc(f.name)}</span>
      <span class="chip ${f.basis === "label" ? "label" : f.basis === "recipe" ? "weighed" : "recalled"}">${f.basis}</span>
      <span class="f-kcal">${f.per_100g.kcal}/100g</span>
      <button class="del">✕</button>`;
    row.querySelector(".f-name").addEventListener("click", () => {
      expandedFoodId = expandedFoodId === f.id ? null : f.id;
      renderFoodsList();
    });
    row.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Delete "${f.name}" from foods?`)) return;
      await Data.foods.del(f.id);
      foods = foods.filter((x) => x.id !== f.id);
      renderFoodsList();
    });
    wrap.appendChild(row);
    if (expandedFoodId === f.id) wrap.appendChild(foodEditor(f));
  }
}

function foodEditor(f) {
  const div = document.createElement("div");
  div.className = "food-editor";
  const per = f.per_100g;
  let ingHtml = "";
  if (f.basis === "recipe") {
    ingHtml = `<p class="hint">Ingredients (edit grams; per-100g recomputes):</p>` +
      (f.ingredients || []).map((ing, i) =>
        `<div class="ingredient-row"><span>${esc(ing.name)}</span><input type="number" data-ing="${i}" value="${ing.grams}" /> g <span>(${Math.round(ing.kcal)} kcal)</span></div>`
      ).join("") +
      `<label>Total batch weight (g)<input type="number" id="fe-total" value="${f.total_g}" /></label>`;
  }
  div.innerHTML = `
    <label>Name<input type="text" id="fe-name" value="${esc(f.name)}" /></label>
    <label>Aliases (comma-separated)<input type="text" id="fe-aliases" value="${esc((f.aliases || []).join(", "))}" /></label>
    ${f.basis !== "recipe" ? `
    <p class="hint">Per 100 g:</p>
    <div class="field-grid">
      <label>kcal<input type="number" id="fe-kcal" step="0.1" value="${per.kcal}" /></label>
      <label>P<input type="number" id="fe-p" step="0.1" value="${per.protein_g}" /></label>
      <label>C<input type="number" id="fe-c" step="0.1" value="${per.carbs_g}" /></label>
      <label>F<input type="number" id="fe-f" step="0.1" value="${per.fat_g}" /></label>
    </div>` : ingHtml}
    <label>Default portion (g)<input type="number" id="fe-default" value="${f.default_g || 100}" /></label>
    <button class="btn small primary" id="fe-save">Save food</button>`;
  div.querySelector("#fe-save").addEventListener("click", async () => {
    f.name = div.querySelector("#fe-name").value.trim() || f.name;
    f.aliases = div.querySelector("#fe-aliases").value.split(",").map((s) => s.trim()).filter(Boolean);
    f.default_g = Number(div.querySelector("#fe-default").value) || f.default_g;
    if (f.basis === "recipe") {
      div.querySelectorAll("[data-ing]").forEach((inp) => {
        const i = Number(inp.dataset.ing);
        const ing = f.ingredients[i];
        const g = Number(inp.value) || ing.grams;
        if (g !== ing.grams && ing.grams > 0) {
          const k = g / ing.grams;
          ing.kcal = r1(ing.kcal * k); ing.protein_g = r1(ing.protein_g * k);
          ing.carbs_g = r1(ing.carbs_g * k); ing.fat_g = r1(ing.fat_g * k);
          ing.grams = g;
        }
      });
      f.total_g = Number(div.querySelector("#fe-total").value) || f.total_g;
      f.per_100g = recipePer100g(f.ingredients, f.total_g);
    } else {
      f.per_100g = {
        kcal: Number(div.querySelector("#fe-kcal").value) || 0,
        protein_g: Number(div.querySelector("#fe-p").value) || 0,
        carbs_g: Number(div.querySelector("#fe-c").value) || 0,
        fat_g: Number(div.querySelector("#fe-f").value) || 0,
      };
    }
    await Data.foods.put(f);
    expandedFoodId = null;
    renderFoodsList();
  });
  return div;
}

function renderSeriesList() {
  const wrap = $("#series-list");
  if (!series.length) { wrap.innerHTML = `<p class="hint">No series yet — created automatically on your first weigh-in.</p>`; return; }
  wrap.innerHTML = series
    .slice().sort((a, b) => (a.start < b.start ? 1 : -1))
    .map((s) => {
      const n = weights.filter((w) => w.series === s.id).length;
      return `<div class="series-row"><span>${esc(s.name)}${s.legacy ? ' <span class="chip legacy">legacy</span>' : ""}</span><span class="s-meta">${s.start} · ${n} weigh-ins</span></div>`;
    }).join("");
}

// ---------- backup / restore ----------
$("#backup-btn").addEventListener("click", async () => {
  await Data.exportBackup();
  renderSettings();
});

$("#restore-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { alert("Not a valid JSON file."); return; }
  try {
    if (json.app === "caltrack" && json.stores) {
      if (!confirm("Restore this backup? ALL current data on this phone will be replaced. A safety export of the current data will be offered first.")) return;
      await Data.exportBackup();
      await Data.restoreBackup(json);
      location.reload();
    } else if (json.legacy) {
      const r = await Data.importLegacy(json);
      await reloadCaches();
      alert(`Imported ${r.entries} chat-era days and ${r.weights} weigh-ins.`);
      renderSettings();
    } else {
      alert("Unrecognized file — expected a CalTrack backup or legacy export.");
    }
  } catch (e) {
    alert("Import failed: " + e.message);
  }
});

// ---------- init ----------
async function reloadCaches() {
  [log, foods, weights, series, corrections] = await Promise.all([
    Data.log.all(), Data.foods.all(), Data.weights.all(), Data.series.all(), Data.corrections.all(),
  ]);
  profile = await Data.getProfile();
}

(async function init() {
  try {
    await Data.init();
    await reloadCaches();
    if (!profile) {
      profile = {
        kcal_targets: DEFAULT_TARGETS.slice(), protein_target: 160,
        tdee: null, tdee_updated: null, tdee_history: [],
      };
      await Data.saveProfile(profile);
    }
  } catch (e) {
    console.error(e);
    alert("Storage init failed: " + e.message);
  }
  logDate = todayStr();
  const hasKey = !!localStorage.getItem("caltrack_api_key");
  showView(hasKey ? "today" : "settings");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
