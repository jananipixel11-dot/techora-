// TECHORA backend: zero dependencies (Node 18+). Run: ADMIN_KEY=yourSecret node server.js
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const DB_FILE = path.join(__dirname, "data.json");

// Only these files are served (nothing else on disk is reachable)
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/admin": ["admin.html", "text/html; charset=utf-8"],
  "/sw.js": ["sw.js", "application/javascript"],
  "/manifest.json": ["manifest.json", "application/manifest+json"],
  "/icon.svg": ["icon.svg", "image/svg+xml"]
};

// Help numbers sent to the app (cached on the phone). Verify and edit for your region and park.
const HELPLINES = {
  IN: [["112", "National emergency"], ["108", "Ambulance"], ["100", "Police"], ["101", "Fire"],
       ["1363", "Tourist helpline"], ["1070", "Tamil Nadu disaster control room"], ["1077", "District disaster control"]],
  US: [["911", "Emergency"]],
  GB: [["999", "Emergency"], ["112", "Emergency"]],
  AU: [["000", "Emergency"], ["112", "Mobile emergency"]],
  EU: [["112", "Emergency (EU)"]]
};

let db = { sos: [], trips: [], last: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE + ".tmp", JSON.stringify(db), (err) => { if (!err) fs.rename(DB_FILE + ".tmp", DB_FILE, () => {}); });
  }, 300);
}

const str = (v, m = 200) => String(v == null ? "" : v).slice(0, m);
const num = (v) => (v !== null && v !== "" && Number.isFinite(+v) ? +v : null);
const validPos = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

// Simple per-IP rate limit: 120 requests / minute
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const limited = (ip) => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 120; };

function isAdmin(req) {
  const a = Buffer.from(String(req.headers["x-admin-key"] || "")), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 20000) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: "Too many requests" });

    if (req.method === "GET" && STATIC[p]) {
      const [file, type] = STATIC[p];
      return fs.readFile(path.join(__dirname, file), (err, data) => err ? send(res, 404, { error: "Not found" }) : send(res, 200, data, type));
    }

    if (req.method === "GET" && p === "/api/helplines") return send(res, 200, HELPLINES);

    if (req.method === "POST" && p.startsWith("/api/") && !p.startsWith("/api/admin/")) {
      const b = await readBody(req);
      const deviceId = str(b.deviceId, 80);
      if (!deviceId) return send(res, 400, { error: "deviceId required" });

      if (p === "/api/ping") {
        const lat = num(b.lat), lon = num(b.lon);
        if (!validPos(lat, lon)) return send(res, 400, { error: "bad position" });
        db.last[deviceId] = { deviceId, name: str(b.name, 60), lat, lon, acc: num(b.acc), t: num(b.t) || Date.now(), received: Date.now() };
        save(); return send(res, 200, { ok: true });
      }
      if (p === "/api/sos") {
        const id = str(b.id, 120);
        if (!id) return send(res, 400, { error: "id required" });
        if (!db.sos.some((s) => s.id === id)) { // idempotent: retries do not duplicate
          const lat = num(b.lat), lon = num(b.lon);
          db.sos.push({ id, deviceId, name: str(b.name, 60), phone: str(b.phone, 30),
            lat: validPos(lat, lon) ? lat : null, lon: validPos(lat, lon) ? lon : null, acc: num(b.acc),
            t: num(b.t) || Date.now(), received: Date.now(), message: str(b.message, 600), resolved: false });
          db.sos = db.sos.slice(-1000);
        }
        save(); return send(res, 200, { ok: true });
      }
      if (p === "/api/trip") {
        db.trips = db.trips.filter((t) => t.deviceId !== deviceId);
        db.trips.push({ deviceId, name: str(b.name, 60), phone: str(b.phone, 30), area: str(b.area, 100),
          group: Math.min(Math.max(parseInt(b.group) || 1, 1), 500),
          returnBy: b.returnBy && !isNaN(Date.parse(b.returnBy)) ? new Date(b.returnBy).toISOString() : null,
          registered: Date.now(), done: false });
        db.trips = db.trips.slice(-2000);
        save(); return send(res, 200, { ok: true });
      }
      if (p === "/api/trip/done") {
        db.trips.forEach((t) => { if (t.deviceId === deviceId) t.done = true; });
        save(); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "Unknown endpoint" });
    }

    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && p === "/api/admin/state") {
        const now = Date.now();
        return send(res, 200, {
          sos: db.sos.slice().sort((a, b) => b.received - a.received).slice(0, 100),
          trips: db.trips.map((t) => Object.assign({}, t, { overdue: !t.done && !!t.returnBy && now > Date.parse(t.returnBy) })),
          last: Object.values(db.last).sort((a, b) => b.received - a.received).slice(0, 200)
        });
      }
      if (req.method === "POST" && p === "/api/admin/resolve") {
        const b = await readBody(req);
        const s = db.sos.find((x) => x.id === str(b.id, 120));
        if (s) { s.resolved = true; save(); }
        return send(res, 200, { ok: !!s });
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 400, { error: "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`TECHORA running at http://localhost:${PORT}  (ranger dashboard: /admin)`);
  if (ADMIN_KEY === "changeme") console.log("WARNING: set ADMIN_KEY before real use.");
});
