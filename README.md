# CalTrack

Phone-only calorie and macro tracker. Log a meal by photographing it, photographing its
nutrition label, or just typing what you ate. Runs entirely in the browser: your data
never leaves your phone, and there is no server to keep running.

## How it works

- **Storage**: IndexedDB on the phone. No account, no cloud, no sync.
- **Model calls**: the browser calls the Anthropic API directly (`claude-sonnet-5`)
  using a key you paste into Settings once. The key is stored in `localStorage` on
  that device only.
- **Hosting**: static files on GitHub Pages. Deploying is `git push`.

## Three ways to log

1. **Scan** — photograph the plate. The model returns a median estimate per item with an
   honest 80% range, and asks at most one question about the single highest-impact thing
   it cannot see (oil, dressing, piece count). It never silently invents an item.
2. **Label** — photograph a nutrition label. Values are read exactly as printed and saved
   to your food database, so that product is exact forever after.
3. **Text** — type "the teriyaki roll and a protein milk". Known foods resolve against your
   food database and recent log, and reuse the *same* macros rather than being re-estimated.

Repeat meals converge on exact numbers: a food saved once is never guessed again.
Recipes work the same way — log the ingredients by weight once plus the final batch weight,
and thereafter "230 g pancake batter" derives precise macros.

## Honest limits

- Photo estimates remain **±20–30%**. That is managed, not solved: every item shows a range,
  carries a provenance tier (label / weighed / photo / recalled), and is editable before saving.
- No barcode scanner. Label-photo mode is the substitute.
- No million-item food database. Yours grows from what you actually eat.
- kcal/protein/carbs/fat only — no micronutrients.
- Single user, no cloud sync. **Backup is the only safety net** — the app nags when the last
  export is over 14 days old, and a restore auto-exports the current data first.

## Cost

$0 hosting. Anthropic API usage only: roughly 1–2k tokens per photo or text entry on
`claude-sonnet-5`, which is a few øre per call, or about **$1–4/month** at 3–6 entries/day.
Images are downscaled to 1024 px before upload, which is what keeps that figure honest.
No subscriptions. Use a dedicated API key with a spend cap.

## Setup

1. Open the Pages URL on your phone.
2. **Install to the home screen first.** On iOS the installed app and Safari do not share
   storage, so anything entered in Safari beforehand is invisible to the installed app.
3. Open the installed app, go to Settings, paste your Anthropic API key.
4. Set the weekday calorie targets and protein target.
5. Optionally import prior history via Settings → Restore / import.

## Adaptive TDEE

Maintenance is not assumed — it is measured. Once a weight series has 12 days of history
with at least 10 weigh-ins and 10 logged days in the trailing 14, the History tab derives
implied maintenance from the smoothed weight trend against logged intake, and offers to
apply it. Revisions are capped at ±150 kcal and at most once a week, so a noisy fortnight
cannot whipsaw the targets. Starting a new series ("new scale / location") isolates the old
data instead of letting a scale change masquerade as weight change.

Weight trend is the arbiter; the correction ledger on the History tab flags whether your
manual edits are consistently one-directional, which is how a quietly biased log gets caught.

## Local development

```
node server.js        # static file server on :5180
node scripts/test-math.js   # pure-function tests
```

`server.js` is a dev convenience only — production is static.

## Files

- `index.html` / `app.js` / `styles.css` — the app (Today, Scan/review, History, Settings)
- `db.js` — IndexedDB layer, backup/restore/legacy import
- `llm.js` — Anthropic calls (structured outputs, thinking disabled)
- `math.js` — pure math: weight smoothing, trend fit, TDEE suggestion, recipe derivation
- `seed/foods.json` — starter food database
- `manifest.webmanifest` / `sw.js` / `icon.svg` — PWA shell

## Privacy

This repository is public and contains **no personal data**: no logs, no weights, no key.
Everything personal lives in IndexedDB on the phone, and `.env` plus `data/` are gitignored.
