// CalTrack pure math — shared by the browser (window.CalMath) and node tests.
(function (global) {
  "use strict";

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const round1 = (n) => Math.round(n * 10) / 10;

  const DAY_MS = 86400000;
  // dates are "YYYY-MM-DD" strings; parse as UTC so DST never shifts a day
  const dayNum = (d) => Math.round(Date.parse(d + "T00:00:00Z") / DAY_MS);
  const daysBetween = (a, b) => dayNum(b) - dayNum(a);

  // Trailing mean with an EXPANDING window at the start: point i is the mean of
  // up to 7 most recent values ending at i. (A strict 7-point window would make
  // the TDEE gate unreachable inside a 14-day window.)
  function rollingMean7(points) {
    return points.map((p, i) => {
      const win = points.slice(Math.max(0, i - 6), i + 1);
      return { date: p.date, kg: mean(win.map((w) => w.kg)) };
    });
  }

  // Least-squares slope in kg/day over {date, kg} points (x = calendar days).
  function linearFitSlope(points) {
    if (points.length < 2) return 0;
    const x0 = dayNum(points[0].date);
    const xs = points.map((p) => dayNum(p.date) - x0);
    const ys = points.map((p) => p.kg);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }

  function residualStdev(points) {
    if (points.length < 3) return 0;
    const slope = linearFitSlope(points);
    const x0 = dayNum(points[0].date);
    const xs = points.map((p) => dayNum(p.date) - x0);
    const ys = points.map((p) => p.kg);
    const mx = mean(xs), my = mean(ys);
    const b = my - slope * mx;
    const res = ys.map((y, i) => y - (slope * xs[i] + b));
    return Math.sqrt(mean(res.map((r) => r * r)));
  }

  // per-100g macros derived from weighed ingredients + final batch weight
  function recipePer100g(ingredients, totalG) {
    const sum = (f) => ingredients.reduce((s, i) => s + (i[f] || 0), 0);
    const k = 100 / totalG;
    return {
      kcal: round1(sum("kcal") * k),
      protein_g: round1(sum("protein_g") * k),
      carbs_g: round1(sum("carbs_g") * k),
      fat_g: round1(sum("fat_g") * k),
    };
  }

  // Adaptive TDEE suggestion. Pure: caller supplies all data.
  //   today        "YYYY-MM-DD"
  //   seriesStart  "YYYY-MM-DD" of the active (non-legacy) weight series
  //   weights      [{date, kg}] within the active series, sorted ascending
  //   intakeDays   [{date, kcal}] days with logged intake (legacy-only days excluded)
  //   tdee         current TDEE (number or null)
  //   tdeeUpdated  "YYYY-MM-DD" of last apply (or null)
  function tdeeSuggestion({ today, seriesStart, weights, intakeDays, tdee, tdeeUpdated }) {
    if (!seriesStart || daysBetween(seriesStart, today) < 12) return { status: "settling" };
    const inWindow = (d) => daysBetween(d.date, today) >= 0 && daysBetween(d.date, today) < 14;
    const win = weights.filter(inWindow);
    if (win.length < 10) return { status: "insufficient-weights" };
    const smooth = rollingMean7(win);
    const kcalFromWeight = linearFitSlope(smooth) * 7700; // kg/day -> kcal/day imbalance
    const days = intakeDays.filter(inWindow);
    if (days.length < 10) return { status: "insufficient-intake" };
    const implied = Math.round(mean(days.map((d) => d.kcal)) - kcalFromWeight);
    if (tdeeUpdated && daysBetween(tdeeUpdated, today) < 7) return { status: "too-soon", implied };
    if (tdee == null) return { status: "ready", implied, suggested: implied, delta: 0, first: true };
    const delta = Math.round(clamp(implied - tdee, -150, 150));
    const rs = residualStdev(smooth);
    const confidence = days.length >= 12 && rs < 0.15 ? "high" : rs < 0.3 ? "medium" : "low";
    return { status: "ready", implied, suggested: tdee + delta, delta, confidence };
  }

  const api = { clamp, mean, round1, daysBetween, rollingMean7, linearFitSlope, residualStdev, recipePer100g, tdeeSuggestion };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.CalMath = api;
})(typeof window !== "undefined" ? window : globalThis);
