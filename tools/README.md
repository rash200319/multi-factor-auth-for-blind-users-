# HTTPS tunnel for testing phone (cross-device) passkeys

Cross-device passkey registration — scanning a QR code and pairing your
phone over Bluetooth — needs real HTTPS to work reliably. Plain
`http://localhost` isn't enough even though browsers treat it as a secure
context; the underlying cross-device protocol (caBLE/hybrid) is unreliable
over it in practice. This folder has a zero-signup way to test that flow
for real.

## What's here

- `cloudflared.exe` — Cloudflare's tunnel client (downloaded, gitignored,
  not committed — it's a ~48MB binary, not source).
- `tunnel.mjs` — starts two free "quick tunnels" (no Cloudflare account
  needed), one for the client (port 5190) and one for the API server (port
  4000), and rewrites `server/.env` / `client/.env.local` to match.
- `logs/` — cloudflared's own logs per tunnel (gitignored).

## Usage

1. Make sure nothing else is on ports 4000/5190 (`netstat -ano | findstr :4000` /
   `:5190` — should be empty, or only your own server/client from a
   previous run).
2. From the repo root:
   ```
   node tools/tunnel.mjs
   ```
   This prints two `https://*.trycloudflare.com` URLs and rewrites the env
   files automatically.
3. **Restart** both dev servers so they pick up the new `.env` values (a
   config change isn't hot-reloaded):
   ```
   npm run dev --workspace server
   npm run dev --workspace client
   ```
4. Open the **client** URL it printed (not the server one) in your laptop
   browser — same browser, just a different address than localhost now.
   Enrol as normal; when you get to the phone step, the QR/Bluetooth flow
   now runs over real HTTPS end to end.

## Why each piece exists

- **`RP_ID`/`ORIGIN`** in `server/.env` get set to the client's tunnel
  domain — WebAuthn checks these strictly, so they have to match wherever
  the page actually loads from.
- **`COOKIE_SAMESITE=none` / `COOKIE_SECURE=true`** — with the client on
  its own tunnel domain and the API still answering from `localhost:4000`,
  they're now genuinely cross-site (different registrable domains), not
  just different ports. A `SameSite=Strict` cookie (the plain-localhost
  default) won't survive that; `SameSite=None` requires `Secure`, which
  requires the response setting it to be HTTPS-adjacent — this is exactly
  what those two flags turn on. See `server/src/services/session.ts`.
- **`client/vite.config.ts` → `server.allowedHosts: [".trycloudflare.com"]`**
  — Vite's dev server refuses requests whose `Host` header it doesn't
  recognise (DNS-rebinding protection) and returns a 403 otherwise. The
  leading dot matches any `*.trycloudflare.com` subdomain, since a fresh
  quick tunnel gets a new random one every run.
- **`VITE_API_BASE`** in `client/.env.local` — points the client's `fetch`
  calls at the server's tunnel URL instead of `localhost:4000`, since the
  page is no longer same-origin with the API once it's on a tunnel domain.

## Going back to plain localhost testing

Quick-tunnel URLs are random and stop working the moment you close
`tunnel.mjs`'s tunnel processes (or restart your machine). If you're done
with phone testing and want to go back to plain `localhost` dev:

1. Delete `client/.env.local` (or just its `VITE_API_BASE` line) —
   otherwise the client keeps trying to reach a dead tunnel URL.
2. In `server/.env`, set `ORIGIN` back to `http://localhost:5190`, `RP_ID`
   back to `localhost`, and remove (or set to `false`/blank)
   `COOKIE_SAMESITE`/`COOKIE_SECURE`.
3. Restart both dev servers.

## Stopping the tunnels

`tunnel.mjs` prints the two process IDs and log paths when it starts them.
They run detached (independent of the script that launched them), so stop
them explicitly when you're done:

```
taskkill /PID <client-pid> /F
taskkill /PID <server-pid> /F
```

Or just close them from Task Manager (look for `cloudflared.exe`).
