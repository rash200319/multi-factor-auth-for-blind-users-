# Deployment — TLS and production config

docs/hardening-plan.md WI-5. This is deployment guidance, not application
code: `tools/tunnel.mjs` already provides real HTTPS for local cross-device
testing (see `tools/README.md`); this file is about a real, non-localhost
deployment.

## What has to change from the localhost dev setup

The app itself does not change. Two things in `server/.env` do:

1. **`ORIGIN` / `RP_ID` must be the real HTTPS origin**, not `localhost`.
   WebAuthn checks these strictly on every ceremony — they must match
   wherever the page actually loads from. This is the same mechanism
   `tools/tunnel.mjs` already exercises for temporary tunnels; a real
   deployment is the same idea, permanent instead of random-per-run.
   ```
   RP_ID=your-domain.example
   ORIGIN=https://your-domain.example
   ```
2. **`COOKIE_SAMESITE` / `COOKIE_SECURE`** — only needed if the client and
   API end up on different registrable domains (genuinely cross-site, not
   just different ports). A same-origin deployment (client and API reachable
   under the same domain, as in the example Caddyfile below) can leave these
   unset, same as plain localhost dev. See `tools/README.md` for the
   cross-site case if the deployment splits them onto separate domains.

## TLS termination

The Express server itself still runs plain HTTP on `localhost` — same as
dev. Put a TLS-terminating reverse proxy in front of it. Caddy is the
simplest option for this project's scale: it gets a Let's Encrypt cert
automatically from a two-line config, no separate certbot/ACME setup.

See `docs/examples/Caddyfile` for a reference config. Adjust the path-based
routing to however the client's built static files and the API are actually
served in the real deployment — the example assumes Caddy serves the
client's static build directly and proxies API routes to the Node process.

Any reverse proxy works the same way in principle (nginx, Cloudflare, a
managed platform's built-in TLS) — the two requirements are the same
regardless of which one is used:
- terminate TLS at the proxy,
- forward to the Express app on `localhost:4000` unencrypted (this is fine —
  proxy-to-app traffic never leaves the same host).

## Not covered here

Real KYC/identity verification for recovery tier 4 is explicitly out of
scope for this project (see `docs/hardening-plan.md` WI-3) — this document
is about transport security, not that.
