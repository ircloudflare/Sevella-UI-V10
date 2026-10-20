const express = require("express");
const httpProxy = require("http-proxy");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookie = require("cookie");
const WebSocket = require("ws");
const { spawn, execFileSync } = require("child_process");

const PORT = process.env.PORT || 8080;
const WS_PATH = "/" + (process.env.WS_PATH || "parsaw").replace(/^\//, "");
const XRAY_INTERNAL_PORT = process.env.XRAY_INTERNAL_PORT || 10086;
const XRAY_API_PORT = process.env.XRAY_API_PORT || 10087;
const DASH_PASS = process.env.DASH_PASS || "change-me";

// Path the dashboard's live-usage websocket listens on. Kept separate from
// WS_PATH (the VLESS inbound path) so the two can never collide.
const USAGE_WS_PATH = "/ws/usage";
// How often (ms) we push a fresh usage snapshot to connected dashboards.
const USAGE_PUSH_INTERVAL_MS = 5000;

// Must match the mount path of the persistent disk (Sevalla: /app/data).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const XRAY_BIN = process.env.XRAY_BIN || "/usr/local/bin/xray";
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const XRAY_CONFIG_PATH = path.join(__dirname, "xray-config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- auth helpers ----------
const SESSION_COOKIE = "vless_session";
const SESSION_TOKEN = crypto.createHmac("sha256", DASH_PASS).update("session-v1").digest("hex");
const SUB_TOKEN = crypto.createHmac("sha256", DASH_PASS).update("sub-token-v1").digest("hex").slice(0, 20);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthed(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return !!cookies[SESSION_COOKIE] && safeEqual(cookies[SESSION_COOKIE], SESSION_TOKEN);
}

function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect("/login");
}

function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ---------- client storage ----------
// Everything lives in DATA_DIR/clients.json, which must sit on the persistent disk.
// Each client:
//   { id, uuid, label, createdAt, dataLimitBytes, expiresAt, expiryDays,
//     uplinkBaseline, downlinkBaseline, snapUplink, snapDownlink, usedBytesBaseline }
// uplinkBaseline / downlinkBaseline = bytes used across *previous* Xray process
//   lifetimes (Xray's own counters reset to 0 every time we restart it, so the last
//   known value is folded in right before each restart).
// snapUplink / snapDownlink = last persisted (baseline + live) reading. It is
//   refreshed every few seconds and on shutdown, so a redeploy, a crash or a
//   SIGKILL loses at most a few seconds of traffic instead of everything since
//   the last config change.
// usedBytesBaseline = uplinkBaseline + downlinkBaseline, written only so an older
//   server version can still read the file.
// dataLimitBytes = optional hard cap in bytes; null/undefined means unlimited.
// expiresAt = optional ISO timestamp after which the client is cut off; null means no expiry.
// expiryDays = the number of days the admin chose when setting expiresAt (display only).
function nonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function baselineTotal(c) {
  return nonNeg(c.uplinkBaseline) + nonNeg(c.downlinkBaseline);
}

function freshUsage() {
  return { uplinkBaseline: 0, downlinkBaseline: 0, snapUplink: 0, snapDownlink: 0 };
}

function normalizeClient(raw) {
  const c = { dataLimitBytes: null, expiresAt: null, expiryDays: null, ...raw };
  if (c.uplinkBaseline == null && c.downlinkBaseline == null) {
    // Record written before upload/download were tracked separately: only the
    // total is known, so it is kept as download (the bulk of proxy traffic).
    c.uplinkBaseline = 0;
    c.downlinkBaseline = nonNeg(c.usedBytesBaseline);
  }
  // Never go backwards: after a crash the snapshot can be newer than the baseline.
  c.uplinkBaseline = Math.max(nonNeg(c.uplinkBaseline), nonNeg(c.snapUplink));
  c.downlinkBaseline = Math.max(nonNeg(c.downlinkBaseline), nonNeg(c.snapDownlink));
  c.snapUplink = c.uplinkBaseline;
  c.snapDownlink = c.downlinkBaseline;
  c.usedBytesBaseline = baselineTotal(c);
  return c;
}

function loadClients() {
  let text;
  try {
    text = fs.readFileSync(CLIENTS_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[storage] cannot read clients file:", err.message);
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.map(normalizeClient);
  } catch (err) {
    // Keep the unreadable file instead of silently replacing it with a fresh default client.
    const backup = `${CLIENTS_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(CLIENTS_FILE, backup);
    } catch {
      /* nothing more we can do */
    }
    console.error(`[storage] clients file is unreadable (${err.message}); copy kept at ${backup}`);
    return [];
  }
}

// Atomic write: write a temp file in the same directory, fsync it, then rename over
// the real file. A kill in the middle of a save can no longer leave a half-written file.
function saveClients(list) {
  const out = list.map((c) => ({ ...c, usedBytesBaseline: baselineTotal(c) }));
  const tmp = `${CLIENTS_FILE}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(out, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CLIENTS_FILE);
}

// A client is "capped" once its known usage (as of the last Xray restart)
// has reached its limit. This is intentionally based on the baseline
// (not live traffic) because the baseline is only ever updated during
// restartXray(), right before buildXrayConfig() runs — so by construction,
// whatever this returns is exactly what the *current* running Xray config
// reflects (capped clients are already excluded from it).
function isCapped(c) {
  return c.dataLimitBytes != null && baselineTotal(c) >= c.dataLimitBytes;
}

// A client is "expired" once the current time passes its expiresAt timestamp.
// Unlike isCapped(), this depends on the clock, so the running Xray config can
// get out of date without any restart happening; enforceLimits() handles that.
function isExpired(c) {
  if (!c.expiresAt) return false;
  const t = Date.parse(c.expiresAt);
  return Number.isFinite(t) && Date.now() >= t;
}

// A client that is capped or expired is left out of the Xray config.
function isBlocked(c) {
  return isCapped(c) || isExpired(c);
}

// Parses a raw expiryDays value from a request body.
// Returns: a positive number of days, null (explicitly no expiry), or the
// string "invalid" if the value is present but not usable.
function parseExpiryDays(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return "invalid";
  return n;
}

function expiryFromDays(days) {
  if (days == null) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// Parses a raw dataLimitBytes value from a request body.
// Returns: a non-negative integer, null (explicitly unlimited), or the
// string "invalid" if the value is present but not a usable positive number.
function parseDataLimitBytes(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "invalid";
  return Math.round(n);
}

let clients = loadClients();
if (clients.length === 0) {
  clients.push({
    id: crypto.randomUUID(),
    uuid: crypto.randomUUID(),
    label: "default",
    createdAt: new Date().toISOString(),
    ...freshUsage(),
    dataLimitBytes: null,
    expiresAt: null,
    expiryDays: null,
  });
  saveClients(clients);
}

function buildVlessLink(host, uuid, label) {
  const remark = encodeURIComponent(label || "VLESS");
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(
    WS_PATH
  )}#${remark}`;
}

// True when the request looks like a normal browser tab (not a subscription
// client or curl-style fetch): browsers explicitly prefer text/html.
//
// NOTE: this used to be `req.accepts(["html", "text/plain"]) === "html"`.
// That looks right but isn't: when a client sends "Accept: */*" (or no
// Accept header at all) — which is exactly what v2rayN, v2rayNG, v2Box,
// NekoBox, Shadowrocket, etc. do when fetching a subscription URL —
// Express/negotiator resolves the tie between "html" and "text/plain" by
// falling back to the order of the array you passed in, and "html" was
// listed first. So real subscription clients were silently getting the
// HTML landing page (with no Subscription-Userinfo header and no base64
// body) instead of the plain-text config, which is why the app showed no
// imported configs. Only treat it as a browser if "text/html" is
// explicitly present in the Accept header, the way real browsers send it.
function wantsHtml(req) {
  const accept = req.headers.accept || "";
  return accept.toLowerCase().includes("text/html");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// Subscription page shown when /sub/:token/:clientId is opened in a browser.
// Layout and behaviour live in public/sub-page.css and public/sub-page.js; the
// server only injects this client's data as JSON. The label is rendered here
// through escapeHtml, and the JSON has "<" escaped so it cannot close the tag.
// Client apps that fetch the same URL never see this page.
function subscriptionPage(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(data.label)}</title>
<link rel="stylesheet" href="/sub-page.css" />
<script>
// Pick theme and language before first paint: saved choice first, then device settings.
(function () {
  var root = document.documentElement;
  var theme = null;
  var lang = null;
  try { theme = localStorage.getItem("sub_theme"); lang = localStorage.getItem("sub_lang"); } catch (e) {}
  if (theme !== "dark" && theme !== "light") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (lang !== "fa" && lang !== "en") {
    lang = /^fa/i.test(navigator.language || "") ? "fa" : "en";
  }
  root.setAttribute("data-theme", theme);
  root.setAttribute("lang", lang);
  root.setAttribute("dir", lang === "fa" ? "rtl" : "ltr");
})();
</script>
</head>
<body>
<main class="wrap">
  <div class="toolbar">
    <div class="seg" role="group" data-i18n-aria="themeGroup" aria-label="Theme">
      <button type="button" data-theme-set="light" data-i18n-aria="lightTheme" aria-label="Light theme">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>
      </button>
      <button type="button" data-theme-set="dark" data-i18n-aria="darkTheme" aria-label="Dark theme">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>
      </button>
    </div>
    <div class="seg" role="group" data-i18n-aria="langGroup" aria-label="Language">
      <button type="button" id="langEn" data-lang-set="en" aria-label="English">EN</button>
      <button type="button" id="langFa" data-lang-set="fa" aria-label="Persian">FA</button>
    </div>
  </div>

  <header class="head">
    <div>
      <div class="k" data-i18n="sub">Subscription</div>
      <h1 class="label" dir="auto">${escapeHtml(data.label)}</h1>
    </div>
    <span class="pill" id="pill"></span>
  </header>

  <section class="card" id="dCard">
    <div class="k" data-i18n="dataLabel"></div>
    <div class="metric"><span class="num" id="dNum"></span><span class="unit" id="dUnit"></span><span class="of" id="dOf"></span></div>
    <div class="track" id="dTrack"><div class="fill f1" id="dFill"></div></div>
    <div class="cap" id="dCap"></div>
  </section>

  <section class="card" id="tCard">
    <div class="k" data-i18n="timeLabel"></div>
    <div class="metric"><span class="num" id="tNum"></span><span class="unit" id="tUnit"></span><span class="of" id="tOf"></span></div>
    <div class="track" id="tTrack"><div class="fill f2" id="tFill"></div></div>
    <div class="cap" id="tCap"></div>
  </section>

  <div class="actions">
    <button type="button" class="btn primary" id="copySub" data-i18n="copySub"></button>
    <div class="row">
      <button type="button" class="btn" id="copyCfg" data-i18n="copyCfg"></button>
      <button type="button" class="btn" id="showQr" data-i18n="qr"></button>
    </div>
  </div>
</main>

<div class="qr-overlay" id="qrOverlay" hidden>
  <div class="qr-modal">
    <div class="qr-head">
      <span class="k" data-i18n="qr"></span>
      <button type="button" class="qr-close" id="qrClose" data-i18n-aria="close" aria-label="Close">&times;</button>
    </div>
    <div class="qr-body" id="qrBody"></div>
  </div>
</div>

<script type="application/json" id="subData">${json}</script>
<script src="/qrcode.min.js"></script>
<script src="/sub-page.js"></script>
</body>
</html>`;
}

// ---------- xray stats ----------
// Reads live (since-last-restart) per-user traffic from Xray's built-in
// StatsService. Client "email" in the Xray config is set to our internal
// client id, so stat names look like: user>>>{clientId}>>>traffic>>>uplink
function queryLiveStats() {
  let out;
  try {
    out = execFileSync(
      XRAY_BIN,
      ["api", "statsquery", `--server=127.0.0.1:${XRAY_API_PORT}`, "-pattern", ""],
      { timeout: 4000 }
    ).toString();
  } catch (err) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return {};
  }

  const map = {};
  (parsed.stat || []).forEach((s) => {
    const m = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(s.name || "");
    if (!m) return;
    const [, clientId, dir] = m;
    if (!map[clientId]) map[clientId] = { uplink: 0, downlink: 0 };
    map[clientId][dir] = Number(s.value) || 0;
  });
  return map;
}

// Cumulative upload/download for a client: previous lifetimes + the running Xray
// process. Never lower than the last persisted snapshot, so a failed stats query
// (Xray busy or restarting) cannot make usage appear to drop.
function currentTotals(c, live) {
  const l = live[c.id] || { uplink: 0, downlink: 0 };
  return {
    uplink: Math.max(nonNeg(c.uplinkBaseline) + l.uplink, nonNeg(c.snapUplink)),
    downlink: Math.max(nonNeg(c.downlinkBaseline) + l.downlink, nonNeg(c.snapDownlink)),
  };
}

// Tracks the previous per-client live counters and which client ids showed
// new traffic since the last periodic check — used for the "active now" dot.
let lastLiveStats = {};
let activeClientIds = new Set();

// trackActivity=true (only from the periodic 5s websocket tick) compares
// this reading against the previous one to decide who's "active right now".
// Other callers (REST /api/usage, the /sub landing page) pass false and just
// read the last-known set, so they don't corrupt the delta baseline with an
// out-of-cadence read.
function getUsageSnapshot(trackActivity = false) {
  const live = queryLiveStats();

  if (trackActivity) {
    const nextActive = new Set();
    Object.keys(live).forEach((id) => {
      const prev = lastLiveStats[id] || { uplink: 0, downlink: 0 };
      const curr = live[id];
      if (curr.uplink > prev.uplink || curr.downlink > prev.downlink) {
        nextActive.add(id);
      }
    });
    activeClientIds = nextActive;
    lastLiveStats = live;
  }

  const result = {};
  clients.forEach((c) => {
    const t = currentTotals(c, live);
    result[c.id] = {
      uplink: t.uplink,
      downlink: t.downlink,
      total: t.uplink + t.downlink,
      active: activeClientIds.has(c.id),
    };
  });
  return result;
}

function publicClientList() {
  return clients.map((c) => ({
    id: c.id,
    uuid: c.uuid,
    label: c.label,
    createdAt: c.createdAt,
    dataLimitBytes: c.dataLimitBytes ?? null,
    capped: isCapped(c),
    expiresAt: c.expiresAt ?? null,
    expired: isExpired(c),
  }));
}

// Builds the "Subscription-Userinfo" header a lot of client apps (v2rayNG,
// NekoBox, Shadowrocket, ...) read to show usage next to a subscription.
// "total" is deliberately omitted, but "expire" (unix seconds) is sent when the
// client has an expiry date, so apps can show the remaining time.
function subscriptionUserinfoHeader(usageEntries, expiresAt) {
  let upload = 0;
  let download = 0;
  usageEntries.forEach((u) => {
    upload += u.uplink || 0;
    download += u.downlink || 0;
  });
  let header = `upload=${upload}; download=${download}`;
  const expireMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(expireMs)) header += `; expire=${Math.floor(expireMs / 1000)}`;
  return header;
}

// ---------- xray process management ----------
let xrayProcess = null;
// Ids of the clients present in the currently running Xray config. Used to
// notice clients that expired after the last restart (see enforceLimits).
let configuredClientIds = new Set();

function buildXrayConfig() {
  return {
    log: { loglevel: "warning" },
    api: {
      tag: "api",
      listen: `127.0.0.1:${XRAY_API_PORT}`,
      services: ["StatsService"],
    },
    stats: {},
    policy: {
      levels: {
        0: { statsUserUplink: true, statsUserDownlink: true },
      },
    },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: Number(XRAY_INTERNAL_PORT),
        protocol: "vless",
        settings: {
          // email must be unique -> use our internal client id, not the label.
          // Clients that have hit their data cap or expired are deliberately left
          // out — this is the actual enforcement mechanism (see isBlocked/enforceLimits).
          clients: clients
            .filter((c) => !isBlocked(c))
            .map((c) => ({ id: c.uuid, level: 0, email: c.id })),
          decryption: "none",
        },
        streamSettings: {
          network: "ws",
          wsSettings: { path: WS_PATH },
        },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      },
    ],
    outbounds: [
      { protocol: "freedom", settings: {} },
      { protocol: "blackhole", tag: "blocked" },
    ],
  };
}

// Folds whatever the running Xray process has counted into each client's baseline
// and saves. Must run before Xray is restarted, because its counters start over at 0.
function foldLiveUsage() {
  if (!xrayProcess) return;
  const live = queryLiveStats();
  clients.forEach((c) => {
    const t = currentTotals(c, live);
    c.uplinkBaseline = t.uplink;
    c.downlinkBaseline = t.downlink;
    c.snapUplink = t.uplink;
    c.snapDownlink = t.downlink;
  });
  saveClients(clients);
}

// opts.skipFold: the caller has already folded usage (and may have changed it on purpose).
function restartXray(opts = {}) {
  if (!opts.skipFold) foldLiveUsage();

  // reset activity tracking — Xray's live counters are about to restart from 0,
  // so any stale "active" state or delta baseline would give a false reading
  lastLiveStats = {};
  activeClientIds = new Set();

  const xrayConfig = buildXrayConfig();
  configuredClientIds = new Set(xrayConfig.inbounds[0].settings.clients.map((c) => c.email));
  fs.writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(xrayConfig, null, 2));

  const old = xrayProcess;
  xrayProcess = spawn(XRAY_BIN, ["run", "-c", XRAY_CONFIG_PATH], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  xrayProcess.on("exit", (code, signal) => {
    console.log(`[xray] exited (code=${code}, signal=${signal})`);
  });

  if (old) old.kill("SIGTERM");

  console.log(`[xray] (re)started with ${clients.length} client(s)`);
}

restartXray();

// Writes the latest (baseline + live) usage to disk. Only touches the disk when a
// number actually changed, and at most once per interval unless forced.
const USAGE_PERSIST_INTERVAL_MS = 4000;
let lastPersistAt = 0;
function persistUsageSnapshot(live, force = false) {
  if (!force && Date.now() - lastPersistAt < USAGE_PERSIST_INTERVAL_MS) return;
  let changed = false;
  clients.forEach((c) => {
    const t = currentTotals(c, live);
    if (t.uplink !== c.snapUplink || t.downlink !== c.snapDownlink) {
      c.snapUplink = t.uplink;
      c.snapDownlink = t.downlink;
      changed = true;
    }
  });
  if (!changed) return;
  lastPersistAt = Date.now();
  try {
    saveClients(clients);
  } catch (err) {
    console.error("[storage] could not save usage:", err.message);
  }
}

// Sevalla sends SIGTERM on every redeploy/restart: save usage first, then stop Xray.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, saving usage before exit`);
  try {
    persistUsageSnapshot(queryLiveStats(), true);
  } catch (err) {
    console.error("[shutdown] could not save usage:", err.message);
  }
  if (xrayProcess) xrayProcess.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------- http server ----------
const app = express();
app.set("trust proxy", true); // Sevalla/Cloudflare sit in front, so respect X-Forwarded-Proto
app.use(express.json());

// index:false so express.static never auto-serves index.html for "/" — we gate that manually
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  const password = req.body && req.body.password;
  if (password && safeEqual(password, DASH_PASS)) {
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(SESSION_COOKIE, SESSION_TOKEN, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.protocol === "https",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      })
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Wrong password" });
});

app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
  );
  res.json({ ok: true });
});

// Subscription link: token-protected (not cookie-protected), meant to be
// pasted straight into a client app's "subscription URL" field. Only a
// single client's link is ever served — there is intentionally no
// "all configs combined" endpoint, since /sub/:token alone (with the
// clientId stripped off) would otherwise hand out every user's config to
// anyone who guesses to trim the URL.
app.get("/sub/:token/:clientId", (req, res) => {
  if (!safeEqual(req.params.token, SUB_TOKEN)) {
    return res.status(404).send("Not found");
  }
  const client = clients.find((c) => c.id === req.params.clientId);
  if (!client) return res.status(404).send("Not found");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
  if (wantsHtml(req)) {
    const usage = getUsageSnapshot(false)[client.id] || { uplink: 0, downlink: 0, total: 0 };
    const data = {
      label: client.label,
      configLink: buildVlessLink(host, client.uuid, client.label),
      subLink: `${req.protocol}://${host}/sub/${SUB_TOKEN}/${client.id}`,
      usedBytes: usage.total,
      dataLimitBytes: client.dataLimitBytes,
      capped: isCapped(client),
      createdAt: client.createdAt,
      expiresAt: client.expiresAt,
      expiryDays: client.expiryDays ?? null,
      expired: isExpired(client),
      serverNow: Date.now(),
    };
    return res
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(subscriptionPage(data));
  }
  const link = buildVlessLink(host, client.uuid, client.label);
  const body = Buffer.from(link, "utf8").toString("base64");
  const usage = getUsageSnapshot(false)[client.id] || { uplink: 0, downlink: 0 };
  res.set("Subscription-Userinfo", subscriptionUserinfoHeader([usage], client.expiresAt));
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(body);
});

app.use("/api", requireAuthApi);

app.get("/api/meta", (req, res) => {
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
  res.json({
    wsPath: WS_PATH,
    usageWsPath: USAGE_WS_PATH,
    // append "/<clientId>" client-side for a single config's sub link —
    // there is no combined "all configs" sub link anymore (see /sub/:token/:clientId)
    subBase: `${req.protocol}://${host}/sub/${SUB_TOKEN}`,
  });
});

app.get("/api/clients", (req, res) => {
  res.json(publicClientList());
});

app.get("/api/usage", (req, res) => {
  res.json(getUsageSnapshot(false));
});

app.post("/api/clients", (req, res) => {
  const label = (req.body && req.body.label ? String(req.body.label) : "").trim() || "New config";
  const limitResult = parseDataLimitBytes(req.body && req.body.dataLimitBytes);
  if (limitResult === "invalid") {
    return res.status(400).json({ error: "dataLimitBytes must be a positive number or null" });
  }
  const daysResult = parseExpiryDays(req.body && req.body.expiryDays);
  if (daysResult === "invalid") {
    return res.status(400).json({ error: "expiryDays must be a positive number or null" });
  }
  const client = {
    id: crypto.randomUUID(),
    uuid: crypto.randomUUID(),
    label,
    createdAt: new Date().toISOString(),
    ...freshUsage(),
    dataLimitBytes: limitResult,
    expiresAt: expiryFromDays(daysResult),
    expiryDays: daysResult,
  };
  clients.push(client);
  saveClients(clients);
  restartXray();
  broadcastUsage(); // let connected dashboards see the new config immediately
  res.status(201).json({
    id: client.id,
    uuid: client.uuid,
    label: client.label,
    createdAt: client.createdAt,
    dataLimitBytes: client.dataLimitBytes,
    capped: false,
    expiresAt: client.expiresAt,
    expired: false,
  });
});

// Updates a client's data cap and/or expiry. Only the fields present in the
// body are touched. dataLimitBytes: null makes the client unlimited again;
// expiryDays: N sets the expiry to N days from now (renewal), and
// expiryDays: null removes the expiry. Always restarts Xray so the new values
// are evaluated immediately — this lets an admin bring a capped or expired
// client back online, or cut one off right away.
app.patch("/api/clients/:id", (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "not found" });

  const body = req.body || {};
  const hasLimit = Object.prototype.hasOwnProperty.call(body, "dataLimitBytes");
  const hasExpiry = Object.prototype.hasOwnProperty.call(body, "expiryDays");
  if (!hasLimit && !hasExpiry) {
    return res.status(400).json({ error: "nothing to update" });
  }

  let limitResult;
  if (hasLimit) {
    limitResult = parseDataLimitBytes(body.dataLimitBytes);
    if (limitResult === "invalid") {
      return res.status(400).json({ error: "dataLimitBytes must be a positive number or null" });
    }
  }

  let daysResult;
  if (hasExpiry) {
    daysResult = parseExpiryDays(body.expiryDays);
    if (daysResult === "invalid") {
      return res.status(400).json({ error: "expiryDays must be a positive number or null" });
    }
  }

  if (hasLimit) client.dataLimitBytes = limitResult;
  if (hasExpiry) {
    client.expiresAt = expiryFromDays(daysResult);
    client.expiryDays = daysResult;
  }
  saveClients(clients);
  restartXray();
  broadcastUsage();
  res.json({
    id: client.id,
    dataLimitBytes: client.dataLimitBytes,
    capped: isCapped(client),
    expiresAt: client.expiresAt,
    expired: isExpired(client),
  });
});

// Zeroes a client's usage counter and, if it was capped, brings it back
// into Xray's config (via restartXray -> buildXrayConfig -> isCapped).
app.post("/api/clients/:id/reset-usage", (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "not found" });

  // Fold first so other clients keep their live usage, then zero this one.
  // (Restarting with the fold would add this client's live counters straight back.)
  foldLiveUsage();
  Object.assign(client, freshUsage());
  saveClients(clients);
  restartXray({ skipFold: true });
  broadcastUsage();
  res.json({ id: client.id, dataLimitBytes: client.dataLimitBytes, capped: isCapped(client) });
});

app.delete("/api/clients/:id", (req, res) => {
  const before = clients.length;
  clients = clients.filter((c) => c.id !== req.params.id);
  if (clients.length === before) {
    return res.status(404).json({ error: "not found" });
  }
  saveClients(clients);
  restartXray();
  broadcastUsage(); // let connected dashboards drop the deleted config immediately
  res.status(204).end();
});

app.get("/", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

const proxy = httpProxy.createProxyServer({
  target: { host: "127.0.0.1", port: Number(XRAY_INTERNAL_PORT) },
  ws: true,
});
proxy.on("error", (err) => console.error("[proxy] error:", err.message));

// ---------- live usage over websocket ----------
// Separate WebSocket server (noServer mode) just for pushing usage snapshots
// to logged-in dashboard tabs. Kept fully independent from the VLESS proxy
// upgrade handling below.
const usageWss = new WebSocket.Server({ noServer: true });
const usageSockets = new Set();

function usageSnapshotPayload() {
  return JSON.stringify({
    type: "usage",
    ts: Date.now(),
    clients: publicClientList(),
    // This is the only place that reads with trackActivity=true — it runs on
    // the fixed 5s interval, so the delta between calls is a meaningful
    // "traffic happened in the last ~5s" signal.
    usage: getUsageSnapshot(true),
  });
}

// Checks whether any client that is still in the running Xray config has
// newly crossed its data limit or passed its expiry time, and if so restarts
// Xray so its config (built by buildXrayConfig, which filters on isBlocked)
// excludes them — cutting any live connection immediately. Runs on every
// periodic tick, independent of whether a dashboard tab is currently
// connected, so limits are enforced even with the dashboard closed.
function enforceLimits() {
  const live = queryLiveStats();
  const newlyCapped = clients.filter((c) => {
    if (c.dataLimitBytes == null || isCapped(c)) return false; // no cap, or already excluded
    const t = currentTotals(c, live);
    return t.uplink + t.downlink >= c.dataLimitBytes;
  });
  const newlyExpired = clients.filter((c) => isExpired(c) && configuredClientIds.has(c.id));

  if (newlyCapped.length > 0 || newlyExpired.length > 0) {
    if (newlyCapped.length > 0) {
      console.log(
        `[limits] hit data cap, restarting without: ${newlyCapped.map((c) => c.label).join(", ")}`
      );
    }
    if (newlyExpired.length > 0) {
      console.log(
        `[limits] expired, restarting without: ${newlyExpired.map((c) => c.label).join(", ")}`
      );
    }
    restartXray();
    return; // restartXray already folded and saved the latest usage
  }
  persistUsageSnapshot(live);
}

function broadcastUsage() {
  enforceLimits();
  if (usageSockets.size === 0) return;
  const payload = usageSnapshotPayload();
  usageSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

setInterval(broadcastUsage, USAGE_PUSH_INTERVAL_MS);

usageWss.on("connection", (ws) => {
  usageSockets.add(ws);
  // send an immediate snapshot so the UI isn't stuck waiting for the next tick
  ws.send(usageSnapshotPayload());
  ws.on("close", () => usageSockets.delete(ws));
  ws.on("error", () => usageSockets.delete(ws));
});

server.on("upgrade", (req, socket, head) => {
  const urlPath = (req.url || "").split("?")[0];

  if (urlPath === USAGE_WS_PATH) {
    if (!isAuthed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    usageWss.handleUpgrade(req, socket, head, (ws) => {
      usageWss.emit("connection", ws, req);
    });
    return;
  }

  if (req.url && req.url.startsWith(WS_PATH)) {
    proxy.ws(req, socket, head);
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`[server] dashboard + vless proxy listening on :${PORT}`);
  console.log(`[server] vless ws path: ${WS_PATH}`);
  console.log(`[server] live usage ws path: ${USAGE_WS_PATH} (push every ${USAGE_PUSH_INTERVAL_MS}ms)`);
});
