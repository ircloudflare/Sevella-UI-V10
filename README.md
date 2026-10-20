# VLESS + Xray + multi-client dashboard (Sevalla-ready)

A single container with:

- **Xray-core** running a **VLESS + WebSocket** inbound on the fixed path **`/parsaw`**, bound to `127.0.0.1` only (not directly reachable from outside).
- A **Node.js** server that:
  - Has a real **login page** protected by a single **password** (no username).
  - Serves a **multi-client dashboard**: create as many configs/UUIDs as you want from the browser, each with its own link and QR code, each independently deletable.
  - Shows **per-config data usage** (upload/download/total), read live from Xray's built-in stats API.
  - Exposes a **combined subscription link** (`/sub/<token>`, all configs) and a **per-config subscription link** (`/sub/<token>/<clientId>`, just that one) — paste either into a client app's "subscription URL" field.
  - Proxies WebSocket traffic on `/parsaw` to the local Xray process.

Adding or removing a client automatically rewrites Xray's config and restarts it (a brief drop for active connections is expected).

## Environment variables

| Key | Description | Default |
|---|---|---|
| `DASH_PASS` | The only password needed to log in | `change-me` — **change this** |
| `WS_PATH` | WebSocket path | `parsaw` |
| `XRAY_INTERNAL_PORT` | Internal Xray port (loopback only) | `10086` |
| `DATA_DIR` | Where `clients.json` is stored; must be the persistent disk's mount path | `/app/data` |
| `PORT` | Public port; Sevalla sets this automatically | `8080` |

## Local test

```bash
docker build -t vless-dashboard .
docker run -p 8080:8080 -e DASH_PASS=mysecret vless-dashboard
```

Open `http://localhost:8080`, you'll be redirected to `/login`, enter `mysecret`.

## Deploying on Sevalla

1. Push this project to a Git repository.
2. Sevalla panel → **Application Hosting** → **Add application** → pick the repo (a `Dockerfile` is in the root, so it's auto-detected).
3. Add one environment variable:

   | Key | Value |
   |---|---|
   | `DASH_PASS` | a strong password of your choice |

   (No need to set `PORT`; `WS_PATH` already defaults to `parsaw`.)

4. Deploy. Sevalla gives you a `*.sevalla.app` domain served over HTTPS via Cloudflare — exactly what `security=tls` in the VLESS link needs.
5. Visit the domain, log in with your password, click **Create** to generate configs, and either copy each `vless://` link / QR code individually, or copy the **subscription link** and paste it into your client's subscription-URL field.

## How usage tracking works

Xray's own stats counters reset to zero every time the Xray process restarts. To show a running total anyway, the server keeps a per-client baseline (upload and download separately) in `data/clients.json` and shows `baseline + live` in the dashboard, on the subscription page and in the `Subscription-Userinfo` header.

The baseline is kept up to date in three ways:

- **On every Xray restart** (adding, deleting or editing a config, a client hitting its limit or expiry): the live counters are folded into the baseline first.
- **Every few seconds while traffic flows**: the current total is written to disk as a snapshot, so a crash or hard kill loses at most a few seconds of traffic.
- **On shutdown** (`SIGTERM`/`SIGINT`, which is what a redeploy or restart sends): the latest total is written before the process exits.

On the next boot the baseline is never lower than the last snapshot, so usage survives redeploys and restarts as long as `/app/data` is on a persistent disk.

"Reset usage" really sets the client to zero; other clients keep their live usage across that restart.

## Persistence (Sevalla disk)

Everything that must survive lives in one file, `data/clients.json`: the client list, labels, UUIDs, data limits, expiry dates (`expiresAt`, `expiryDays`) and the usage counters described above.

1. In Sevalla open the application, go to **Disks**, and create a disk on the **web process** with the mount path exactly **`/app/data`**.
2. Deploy again. A new disk starts empty and hides anything the image had at that path (the image has nothing there that matters).
3. Check that it works: create a config with a limit and some days, use it a bit, restart or redeploy, and confirm the usage, limit and remaining days are still there.

Notes:

- A process with a disk is limited to one instance, which is what this app needs anyway (Xray and the usage counters live in one process).
- The file is written atomically (temp file + rename). If it is ever unreadable, a copy is kept as `clients.json.corrupt-<timestamp>` next to it instead of being overwritten by a fresh default config.
- If you mount the disk somewhere else, set the `DATA_DIR` environment variable to the same path.
- Do not rotate `DASH_PASS` casually: subscription tokens are derived from it, so every subscription link changes with it.

## Subscription page

Opening a client's subscription link in a browser shows a read-only glass-style page with data used / remaining, days left, an expiry date, and three actions: copy subscription link, copy config link and a QR code. It has a light/dark toggle and an English/Persian toggle; the first visit follows the device theme and browser language, and the choice is remembered in the browser. The client label is shown as typed and is never translated. Dates stay Gregorian in both languages. Client apps that fetch the same link still receive the plain subscription payload, plus `expire` in the `Subscription-Userinfo` header when the client has an expiry.

The page is `public/sub-page.css` + `public/sub-page.js`; the server only injects the client's data.

## Data limit and expiry

Each client can have a data limit and/or an expiry in days (set when creating it, or later with **Edit**). A client that reaches its limit or expiry is removed from Xray's config within about 5 seconds and any live connection is cut. Changing the limit or setting a new number of days brings it back online. Days are counted from the moment you save them, not from the first connection.

## Security notes

- Change `DASH_PASS` and keep it private — anyone with it can create, view, or delete configs.
- The subscription link's token is derived from `DASH_PASS`; if you rotate the password, the subscription URL changes too (old subscription links stop working).
- `/parsaw` is fixed per your request; if you ever want it random/unguessable, just override `WS_PATH`.
- Xray only listens on `127.0.0.1` — the only way in from outside is through `/parsaw` behind the Node proxy.
