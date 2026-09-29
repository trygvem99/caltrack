# Weekly review brief

Instructions for the scheduled cloud agent that reviews this app every Monday.
Written to be read cold, with no prior context.

## What the app is

CalTrack is a phone-only calorie and macro tracker, used daily on an iPhone by
one person. Vanilla JS, no build step, served as static files from GitHub
Pages. Live at https://trygvem99.github.io/caltrack

| File | What it is |
|---|---|
| `app.js` | UI and all app logic, ~2100 lines, **no unit tests** |
| `db.js` | hand-rolled IndexedDB layer |
| `math.js` | pure math, unit-tested |
| `llm.js` | direct browser calls to the Anthropic API |
| `cloud.js` | mirrors a full backup to a **private** GitHub repo |
| `sw.js` | service worker |
| `scripts/test-math.js` | node, covers `math.js` only |
| `scripts/smoke.js` | browser-only, **cannot run in the cloud environment** |

Read `CLAUDE.md` in the repository root and follow it: surgical changes,
minimum code, no speculative abstractions.

## Task

1. Run `node scripts/test-math.js`, and `node --check` on every `.js` file.
   Report any failure.
2. Review for **real** defects, in this order of priority:
   1. **Data loss or corruption** — IndexedDB handling, backup and restore,
      anything that clears or overwrites stored data.
   2. **Silent failure** — an error path that leaves the user on a screen with
      no message, a promise that can never settle, a swallowed catch, a
      cancelled `prompt()` treated as a value.
   3. **Correctness** — calorie and macro maths, the correction ledger,
      per-weekday maintenance, the zone bar, date handling across timezones.
   4. **Privacy** — this repo is **public**. No personal data (meals, weights,
      API keys, tokens) may ever be committed. `caltrack-backup.json` is
      gitignored and must stay that way.
   5. **Phone reality** — iOS Safari and installed-PWA behaviour, storage
      eviction, offline, memory on large photos.
3. Fix only what you are confident about. Leave anything uncertain as a
   finding, described, unfixed.
4. Add or extend a test for every behavioural fix: `scripts/test-math.js` for
   pure logic, `scripts/smoke.js` for anything that needs a DOM. A fix with no
   test is worth less than one with.

## Known history — do not "fix" these back

These were deliberate, hard-won decisions. Read the comments before changing.

- The service worker is **network-first** with `cache: "no-cache"`. Cache-first
  once made deploys invisible for ten minutes.
- `[hidden] { display: none !important; }` in `styles.css` is load-bearing. An
  author `display` rule once defeated `hidden` and left a full-screen overlay
  swallowing every tap.
- The zone bar scale **starts at zero**. Anchoring it near the thresholds left
  the bar at 0% for the first ~2000 kcal of every day.
- `est` on a logged item is the model's own figure and is never uplifted. The
  pastry uplift is applied on top and recorded separately so estimates stay
  auditable.
- Transactions in `db.js` must reject on `abort`. Without it a cold start hung
  forever and showed an empty diary.
- Comparators must return 0 for equal keys.

## Output

Create a branch and **open a pull request**. Never push to `main`: it deploys
straight to the live app the user depends on daily.

The PR description is the review. Structure it as:

- **Ran** — test results, one line.
- **Fixed** — each fix, what was wrong, how it failed in practice, how it is
  tested.
- **Found, not fixed** — each finding, why you left it, what you would need to
  be sure.
- **Nothing to report** — say so plainly if that is the honest answer. A PR
  with no changes and an empty findings list is a perfectly good week. Do not
  invent work, do not refactor for its own sake, and do not restyle code that
  is merely not to your taste.
