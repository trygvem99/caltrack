// CalTrack local dev server — static files only.
// Production is GitHub Pages (static); the app talks to the Anthropic API
// directly from the browser (see llm.js), so there is no API route here.
// Usage: node server.js   →   http://localhost:5180  (and LAN IP for phone)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 5180;
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end("Forbidden");
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal);
    console.log(`CalTrack (dev) → http://localhost:${PORT}`);
    if (lan) console.log(`On your phone  → http://${lan.address}:${PORT}`);
  });
