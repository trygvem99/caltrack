// Off-device backup to a private GitHub repository. The phone's browser
// storage is a cache the OS may evict under storage pressure; the copy kept
// here is the one that survives that. Every local write schedules an upload
// of the full snapshot (a few hundred KB); a fresh, near-empty database is
// never allowed to overwrite a fuller copy automatically.
"use strict";

const Cloud = (() => {
  const API = "https://api.github.com";
  const PATH = "caltrack-backup.json";
  const KEY_TOKEN = "caltrack_gh_token", KEY_REPO = "caltrack_gh_repo";
  const token = () => localStorage.getItem(KEY_TOKEN) || "";
  const repo = () => localStorage.getItem(KEY_REPO) || "";
  const enabled = () => !!(token() && repo());

  let timer = null, busy = false, dirty = false, blocked = false, lastError = null;
  let cloud = null; // what is on GitHub, once looked at: {log, foods, exported_at, sha}
  const listeners = [];
  const notify = () => listeners.forEach((f) => f());

  async function gh(path, { method = "GET", body, raw = false } = {}) {
    const res = await fetch(API + path, {
      method, body,
      headers: {
        Authorization: "Bearer " + token(),
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg += " " + (await res.json()).message; } catch { msg += " " + res.statusText; }
      const err = new Error("GitHub " + msg);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  }

  // btoa() only takes latin1; go through UTF-8 bytes in chunks
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const counts = (snap) => ({
    log: (snap.stores?.log || []).length,
    foods: (snap.stores?.foods || []).length,
    exported_at: snap.exported_at || null,
  });

  // Returns the cloud snapshot, or null when the repo has no backup yet.
  async function download() {
    let meta;
    try {
      meta = await gh(`/repos/${repo()}/contents/${PATH}`);
    } catch (e) {
      if (e.status === 404) { cloud = { log: 0, foods: 0, exported_at: null, sha: null }; return null; }
      throw e;
    }
    // the JSON form inlines content only up to 1 MB; the raw form has no such limit
    const snap = JSON.parse(await gh(`/repos/${repo()}/contents/${PATH}`, { raw: true }));
    cloud = { ...counts(snap), sha: meta.sha };
    return snap;
  }

  async function upload(snap, { force = false } = {}) {
    if (!enabled()) return;
    if (busy) { dirty = true; return; }
    busy = true; notify();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!cloud) await download();
        const local = counts(snap);
        if (!force && cloud.log > 0 && local.log < cloud.log / 2) { blocked = true; return; }
        blocked = false;
        const body = { message: `backup ${local.exported_at}`, content: b64(JSON.stringify(snap)) };
        if (cloud.sha) body.sha = cloud.sha;
        try {
          const r = await gh(`/repos/${repo()}/contents/${PATH}`, { method: "PUT", body: JSON.stringify(body) });
          cloud = { ...local, sha: r.content.sha };
          localStorage.setItem("caltrack_last_backup", String(Date.now()));
          lastError = null;
          return;
        } catch (e) {
          // another device wrote in between: re-read its sha and try once more
          if ((e.status === 409 || e.status === 422) && attempt === 0) { cloud = null; continue; }
          throw e;
        }
      }
    } catch (e) {
      lastError = e.message;
      throw e;
    } finally {
      busy = false;
      notify();
      if (dirty) { dirty = false; schedule(); }
    }
  }

  async function flush() {
    clearTimeout(timer); timer = null;
    if (!enabled()) return;
    try { await upload(await Data.snapshot()); } catch { /* shown in status */ }
  }
  function schedule() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 3000);
  }
  // phones background the app abruptly; push a pending upload out before that
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) flush(); });

  async function setup(tok, rep) {
    localStorage.setItem(KEY_TOKEN, tok.trim());
    localStorage.setItem(KEY_REPO, rep.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, ""));
    cloud = null; lastError = null; blocked = false;
    await download(); // validates the token and repo in one call
    notify();
  }
  function forget() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_REPO);
    cloud = null; blocked = false; lastError = null;
    notify();
  }
  const status = () => ({
    enabled: enabled(), repo: repo(), busy, blocked, lastError, cloud,
    lastAt: Number(localStorage.getItem("caltrack_last_backup") || 0),
  });

  return { enabled, download, upload, schedule, flush, setup, forget, status, onChange: (f) => listeners.push(f) };
})();
