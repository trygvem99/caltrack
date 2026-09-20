// Browser smoke checks. Paste-run in the page console, or call from a driver:
//   await CalSmoke.run()
// Catches the class of failure unit tests structurally cannot see — an element
// that is hidden in the DOM but still painted, or a control that exists but is
// covered by something else and therefore untappable.
(function (global) {
  "use strict";

  const fail = [];
  const check = (ok, msg) => { if (!ok) fail.push(msg); };

  // 1. Nothing marked hidden may still be painted. An author `display` rule
  //    silently defeats the `hidden` attribute; that once left a full-screen
  //    overlay swallowing every tap on an app that looked fine in the DOM.
  function hiddenNotPainted() {
    for (const el of document.querySelectorAll("[hidden]")) {
      if (getComputedStyle(el).display !== "none") {
        fail.push(`hidden element still painted: ${el.id || el.tagName}`);
      }
    }
  }

  // 2. Every visible control must be the thing you actually hit at its own
  //    centre. Programmatic .click() bypasses hit-testing and cannot catch this.
  function controlsReachable(label) {
    for (const el of document.querySelectorAll("button, input, select, label.fab, a")) {
      if (el.offsetParent === null) continue;
      if (el.closest("details:not([open])")) continue; // collapsed, not interactive
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue; // needs scroll
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        fail.push(`[${label}] ${el.id || el.tagName} is covered by ${hit.id || hit.tagName}`);
      }
    }
  }

  // 3. Nothing may overflow horizontally on a phone.
  function noHorizontalOverflow(label) {
    check(document.body.scrollWidth <= innerWidth + 1, `[${label}] horizontal overflow`);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const show = (v) => { document.querySelector(`[data-view="${v}"]`).click(); return wait(180); };

  // 4. A per-weekday maintenance edit must persist without any Save tap, and
  //    Today must draw THAT day's figure. Shipped once as seven empty boxes
  //    and once as a grid that forgot its values on leaving the tab.
  async function maintenanceRoundTrip() {
    const orig = JSON.parse(JSON.stringify(profile));
    const origDate = logDate;
    try {
      await show("settings");
      const sat = document.querySelector('#maintenance-grid input[data-mday="6"]');
      sat.value = "3400";
      sat.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(250);
      const stored = await Data.getProfile();
      check(stored.maintenance?.[6] === 3400, "maintenance edit did not persist without Save");
      const note = document.querySelector("#cut-mode-note").textContent;
      const cutOn = document.querySelector("#f-cut-mode").checked;
      check(!cutOn || /Sat 3400/.test(note), "cut-mode note does not show the per-day figure");

      profile.cut_mode = true;
      const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); // most recent Saturday (future dates are clamped to today)
      logDate = d.toISOString().slice(0, 10);
      await show("today");
      renderToday();
      const legend = document.querySelector("#zb-scale").textContent;
      check(/Maint 3400/.test(legend), `Saturday bar does not use Saturday's maintenance: "${legend}"`);
    } finally {
      profile = orig;
      await Data.saveProfile(profile);
      logDate = origDate;
      await show("today");
      renderToday();
    }
  }

  // 5. A failure must be visible, never a silent return to the same screen.
  function errorsAreVisible() {
    const t = document.querySelector("#toast");
    check(!!t && typeof showError === "function", "no error surface");
    if (t) {
      showError("smoke: visible?");
      check(getComputedStyle(t).display !== "none", "error toast not painted");
      t.hidden = true;
    }
  }

  async function run() {
    fail.length = 0;

    for (const v of ["today", "history", "settings"]) {
      await show(v);
      hiddenNotPainted();
      controlsReachable(v);
      noHorizontalOverflow(v);
    }

    // the review screen is only reachable through a flow, so drive it
    await show("today");
    if (typeof startScanView === "function") {
      startScanView();
      // bare assignment reaches app.js's top-level `let`; window.scanItems would not
      scanItems = [{
        name: "smoke", grams: 100,
        base: { portion_g: 100, kcal: 200, protein_g: 5, carbs_g: 20, fat_g: 10 },
        est: null, provenance: "photo", unc: 0.2, unresolved: false,
        hidden_factor: null, food_id: null, source: "model",
      }];
      openReview();
      await new Promise((r) => setTimeout(r, 180));
      hiddenNotPainted();
      controlsReachable("review");
      document.querySelector("#cancel-scan-btn").click();
      await wait(150);
    }

    if (typeof profile !== "undefined" && profile) await maintenanceRoundTrip();
    errorsAreVisible();

    // return a copy: `fail` is reused and cleared by the next run, which would
    // otherwise empty the failure list a caller is still holding
    return fail.length
      ? { ok: false, failures: fail.slice() }
      : { ok: true, checks: "hidden/reachable/overflow across today, history, settings, review; maintenance round-trip; error surface" };
  }

  global.CalSmoke = { run };
})(typeof window !== "undefined" ? window : globalThis);
