// node scripts/test-math.js — pure-function tests for math.js
"use strict";
const assert = require("assert");
const M = require("../math.js");

const d = (offset) => {
  const base = Date.parse("2026-08-14T00:00:00Z") + offset * 86400000;
  return new Date(base).toISOString().slice(0, 10);
};

// clamp
assert.strictEqual(M.clamp(500, -150, 150), 150);
assert.strictEqual(M.clamp(-500, -150, 150), -150);
assert.strictEqual(M.clamp(42, -150, 150), 42);

// daysBetween
assert.strictEqual(M.daysBetween("2026-08-14", "2026-08-26"), 12);

// rollingMean7: expanding window at the start
const flat = Array.from({ length: 14 }, (_, i) => ({ date: d(i), kg: 70 }));
const smoothFlat = M.rollingMean7(flat);
assert.strictEqual(smoothFlat.length, 14, "expanding window keeps all points");
assert.ok(smoothFlat.every((p) => Math.abs(p.kg - 70) < 1e-9));
const ramp = Array.from({ length: 8 }, (_, i) => ({ date: d(i), kg: 70 + i }));
const smoothRamp = M.rollingMean7(ramp);
assert.strictEqual(smoothRamp[0].kg, 70, "first point is itself");
assert.strictEqual(smoothRamp[1].kg, 70.5, "second point averages 2");
assert.strictEqual(smoothRamp[7].kg, (71 + 72 + 73 + 74 + 75 + 76 + 77) / 7, "later points use full 7");

// linearFitSlope: perfect ramp of +0.1 kg/day
const ramp2 = Array.from({ length: 10 }, (_, i) => ({ date: d(i), kg: 68 + 0.1 * i }));
assert.ok(Math.abs(M.linearFitSlope(ramp2) - 0.1) < 1e-9);

// recipePer100g: 4 pancake-batter ingredients, 900 g batter
const ingredients = [
  { name: "flour", grams: 200, kcal: 728, protein_g: 20, carbs_g: 152, fat_g: 2 },
  { name: "milk", grams: 400, kcal: 124, protein_g: 14, carbs_g: 12.4, fat_g: 2 },
  { name: "eggs", grams: 150, kcal: 215, protein_g: 19, carbs_g: 1.1, fat_g: 15 },
  { name: "butter", grams: 30, kcal: 217, protein_g: 0.2, carbs_g: 0, fat_g: 24 },
];
const per = M.recipePer100g(ingredients, 700);
assert.strictEqual(per.kcal, M.round1((728 + 124 + 215 + 217) / 7));
// logging 230 g of batter yields exactly 2.3x per-100g
assert.ok(Math.abs(per.kcal * 2.3 - ((728 + 124 + 215 + 217) / 700) * 230) < 0.5);

// --- tdeeSuggestion gates ---
const mkWeights = (n, start, slopePerDay) =>
  Array.from({ length: n }, (_, i) => ({ date: d(i - n + 1), kg: 68 + slopePerDay * i, series: "s1" }));
const mkIntake = (n, kcal) => Array.from({ length: n }, (_, i) => ({ date: d(-i), kcal }));

// settling: series younger than 12 days
assert.strictEqual(
  M.tdeeSuggestion({ today: d(0), seriesStart: d(-5), weights: mkWeights(6, d(-5), 0), intakeDays: mkIntake(6, 2800), tdee: 2800, tdeeUpdated: null }).status,
  "settling"
);

// insufficient weights: old series but only 6 weigh-ins in window
assert.strictEqual(
  M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(6, d(-5), 0), intakeDays: mkIntake(12, 2800), tdee: 2800, tdeeUpdated: null }).status,
  "insufficient-weights"
);

// insufficient intake
assert.strictEqual(
  M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), 0), intakeDays: mkIntake(5, 2800), tdee: 2800, tdeeUpdated: null }).status,
  "insufficient-intake"
);

// too-soon: applied 3 days ago
const tooSoon = M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), 0), intakeDays: mkIntake(12, 2800), tdee: 2800, tdeeUpdated: d(-3) });
assert.strictEqual(tooSoon.status, "too-soon");
assert.ok(typeof tooSoon.implied === "number");

// ready: flat weight at 2800 intake -> implied ~2800, delta 0
const ready = M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), 0), intakeDays: mkIntake(12, 2800), tdee: 2800, tdeeUpdated: null });
assert.strictEqual(ready.status, "ready");
assert.ok(Math.abs(ready.implied - 2800) < 25, `implied ${ready.implied}`);
assert.strictEqual(ready.suggested, 2800 + ready.delta);

// cap: intake 2800 but LOSING 0.1 kg/day -> implied ~2800+770=3570, delta capped +150
const capped = M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), -0.1), intakeDays: mkIntake(12, 2800), tdee: 2800, tdeeUpdated: null });
assert.strictEqual(capped.status, "ready");
assert.ok(capped.implied > 3300, `implied ${capped.implied}`);
assert.strictEqual(capped.delta, 150, "delta capped at +150");
assert.strictEqual(capped.suggested, 2950);

// cap the other way: gaining fast -> delta capped at -150
const cappedDown = M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), 0.1), intakeDays: mkIntake(12, 2800), tdee: 2800, tdeeUpdated: null });
assert.strictEqual(cappedDown.delta, -150);

// timeline check from the plan: Norway series starts 14 Aug -> first possible
// "ready" is 26 Aug (12 days settling) given daily weigh-ins and logging
const aug = (day) => `2026-08-${String(day).padStart(2, "0")}`;
const norwayWeights = Array.from({ length: 13 }, (_, i) => ({ date: aug(14 + i), kg: 74 }));
const norwayIntake = Array.from({ length: 13 }, (_, i) => ({ date: aug(14 + i), kcal: 2900 }));
assert.strictEqual(
  M.tdeeSuggestion({ today: aug(25), seriesStart: aug(14), weights: norwayWeights, intakeDays: norwayIntake, tdee: 2800, tdeeUpdated: null }).status,
  "settling", "25 Aug is still settling"
);
const aug26 = M.tdeeSuggestion({ today: aug(26), seriesStart: aug(14), weights: norwayWeights, intakeDays: norwayIntake, tdee: 2800, tdeeUpdated: null });
assert.strictEqual(aug26.status, "ready", `26 Aug should be ready, got ${aug26.status}`);

// first-time TDEE (null) -> suggested = implied
const first = M.tdeeSuggestion({ today: d(0), seriesStart: d(-20), weights: mkWeights(13, d(-12), 0), intakeDays: mkIntake(12, 2800), tdee: null, tdeeUpdated: null });
assert.strictEqual(first.status, "ready");
assert.strictEqual(first.suggested, first.implied);

// correction threshold: 2% relative deviation
const dev = (scaled, final) => Math.abs(final - scaled) / scaled > 0.02;
assert.ok(!dev(500, 508), "1.6% not a correction");
assert.ok(dev(500, 515), "3% is a correction");

console.log("All math tests passed.");

// --- zone bar geometry (regression: the bar must move on the first meal) ---
const D = 500, MAINT = 3100;
assert.strictEqual(M.zoneBarTop(MAINT, D), 4100, "bar tops out where red begins");
assert.strictEqual(M.zoneBarPct(0, MAINT, D), 0);
assert.ok(M.zoneBarPct(120, MAINT, D) > 2, "a 120 kcal snack must visibly move the bar");
assert.ok(M.zoneBarPct(620, MAINT, D) > 14, "a normal breakfast must be clearly visible");
// the scale must be anchored at zero — this is the bug that shipped
for (const k of [50, 120, 350, 620, 1100, 1800]) {
  assert.ok(M.zoneBarPct(k, MAINT, D) > 0, `intake ${k} must not render as an empty bar`);
}
// monotonic and clamped
let prev = -1;
for (const k of [0, 500, 1500, 2600, 3100, 3600, 4100, 9000]) {
  const p = M.zoneBarPct(k, MAINT, D);
  assert.ok(p >= prev, "bar never goes backwards"); prev = p;
  assert.ok(p <= 100, "bar never exceeds 100%");
}
assert.strictEqual(M.zoneBarPct(9000, MAINT, D), 100, "clamps at the top");

// zone boundaries
assert.strictEqual(M.zoneKey(2600, MAINT, D), "cut");
assert.strictEqual(M.zoneKey(2601, MAINT, D), "maint");
assert.strictEqual(M.zoneKey(3100, MAINT, D), "maint");
assert.strictEqual(M.zoneKey(3101, MAINT, D), "bulk");
assert.strictEqual(M.zoneKey(4100, MAINT, D), "bulk");
assert.strictEqual(M.zoneKey(4101, MAINT, D), "over");

console.log("Zone bar tests passed.");
