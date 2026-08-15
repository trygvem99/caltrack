// CalTrack storage — hand-rolled IndexedDB module, no libraries.
// Stores: log (id, index date), foods (id), weights (date), series (id),
// corrections (auto id), profile (key). API key lives in localStorage.
"use strict";

const DB = (() => {
  const NAME = "caltrack";
  const VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const log = db.createObjectStore("log", { keyPath: "id" });
        log.createIndex("date", "date");
        db.createObjectStore("foods", { keyPath: "id" });
        db.createObjectStore("weights", { keyPath: "date" });
        db.createObjectStore("series", { keyPath: "id" });
        db.createObjectStore("corrections", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("profile", { keyPath: "key" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      t.onerror = () => reject(t.error);
    }));
  }

  const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
  const bulkPut = (store, values) => tx(store, "readwrite", (s) => { values.forEach((v) => s.put(v)); });
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const clear = (store) => tx(store, "readwrite", (s) => s.clear());
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
  const getAllByIndex = (store, index, value) =>
    tx(store, "readonly", (s) => s.index(index).getAll(value));
  const add = (store, value) => tx(store, "readwrite", (s) => s.add(value));

  return { open, put, bulkPut, del, clear, get, getAll, getAllByIndex, add };
})();

const Data = (() => {
  const STORES = ["log", "foods", "weights", "series", "corrections", "profile"];
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function init() {
    await DB.open();
    if ("storage" in navigator && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    const seeded = await DB.get("profile", "seeded");
    if (!seeded) {
      try {
        const res = await fetch("seed/foods.json");
        if (res.ok) {
          const foods = await res.json();
          await DB.bulkPut("foods", foods);
        }
      } catch (e) {
        console.warn("Seed import skipped:", e);
      }
      await DB.put("profile", { key: "seeded", at: new Date().toISOString() });
    }
  }

  // ---- profile (single record under key "profile") ----
  async function getProfile() {
    const rec = await DB.get("profile", "profile");
    return rec ? rec.value : null;
  }
  const saveProfile = (value) => DB.put("profile", { key: "profile", value });

  // ---- backup / restore / legacy import ----
  async function exportBackup() {
    const stores = {};
    for (const s of STORES) stores[s] = await DB.getAll(s);
    const payload = {
      app: "caltrack", format: 1,
      exported_at: new Date().toISOString(),
      api_key_present: !!localStorage.getItem("caltrack_api_key"),
      stores,
    };
    const name = `caltrack-backup-${payload.exported_at.slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const file = new File([blob], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); }
      catch (e) { if (e.name !== "AbortError") download(blob, name); else return false; }
    } else {
      download(blob, name);
    }
    localStorage.setItem("caltrack_last_backup", String(Date.now()));
    return true;
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Replace-all restore from a backup file (caller confirms + pre-exports).
  async function restoreBackup(json) {
    if (json.app !== "caltrack" || !json.stores) throw new Error("Not a CalTrack backup file");
    for (const s of STORES) {
      await DB.clear(s);
      if (Array.isArray(json.stores[s])) await DB.bulkPut(s, json.stores[s]);
    }
  }

  // Merge-import of chat-era history. Idempotent: entries carry deterministic
  // ids ("legacy-YYYY-MM-DD"), weights are keyed by date, series by id.
  async function importLegacy(json) {
    if (!json.legacy) throw new Error("Not a CalTrack legacy file");
    if (Array.isArray(json.series)) await DB.bulkPut("series", json.series);
    if (Array.isArray(json.weights)) await DB.bulkPut("weights", json.weights);
    if (Array.isArray(json.entries)) await DB.bulkPut("log", json.entries);
    return { entries: (json.entries || []).length, weights: (json.weights || []).length };
  }

  return {
    init, newId, getProfile, saveProfile,
    exportBackup, restoreBackup, importLegacy,
    log: {
      all: () => DB.getAll("log"),
      byDate: (d) => DB.getAllByIndex("log", "date", d),
      put: (e) => DB.put("log", e),
      del: (id) => DB.del("log", id),
    },
    foods: {
      all: () => DB.getAll("foods"),
      get: (id) => DB.get("foods", id),
      put: (f) => DB.put("foods", f),
      del: (id) => DB.del("foods", id),
    },
    weights: {
      all: () => DB.getAll("weights"),
      put: (w) => DB.put("weights", w),
      del: (date) => DB.del("weights", date),
    },
    series: {
      all: () => DB.getAll("series"),
      put: (s) => DB.put("series", s),
    },
    corrections: {
      all: () => DB.getAll("corrections"),
      add: (c) => DB.add("corrections", c),
    },
  };
})();
