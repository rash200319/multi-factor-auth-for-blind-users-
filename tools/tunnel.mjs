#!/usr/bin/env node
// Starts two free Cloudflare "quick tunnels" (no account/signup needed) —
// one for the client (5190), one for the API server (4000) — and rewrites
// server/.env and client/.env.local to point at them. This is what makes
// cross-device (QR + Bluetooth phone) passkey registration reliable: it
// needs real HTTPS, which plain http://localhost can't give it.
//
// Quick-tunnel URLs are random and change every run, so re-run this script
// each time you start a new tunnel session, then restart the server and
// client dev processes to pick up the new .env values.
//
// Usage:  node tools/tunnel.mjs

import { spawn, execSync } from "node:child_process";
import { openSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLOUDFLARED = join(__dirname, "cloudflared.exe");
const LOG_DIR = join(__dirname, "logs");

if (!existsSync(CLOUDFLARED)) {
  console.error(`cloudflared.exe not found at ${CLOUDFLARED}`);
  process.exit(1);
}
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR);

// A real quick-tunnel hostname is a random string of hyphenated words,
// e.g. "corrections-half-ownership-babies.trycloudflare.com". Explicitly
// excludes "api.trycloudflare.com" — cloudflared's own provisioning API,
// which shows up in its own log lines (including error messages when
// provisioning fails) and must never be mistaken for an actual tunnel.
const URL_RE = /https:\/\/(?!api\.trycloudflare\.com)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

function startTunnel(name, port) {
  const logPath = join(LOG_DIR, `${name}.log`);
  const fd = openSync(logPath, "w");
  const state = { exited: false, exitCode: null };
  const child = spawn(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  // Recorded even though the process is detached — the listener itself
  // doesn't require staying attached, and lets waitForUrl fail fast
  // instead of polling the full timeout when cloudflared has already died.
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  child.unref();
  return { name, port, logPath, pid: child.pid, state };
}

function waitForUrl(tunnel, timeoutMs = 30000) {
  const { logPath, state, name } = tunnel;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf8");
        const match = content.match(URL_RE);
        if (match) return resolve(match[0]);
      }
      if (state.exited) {
        const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").split(/\r?\n/).slice(-5).join("\n") : "";
        return reject(
          new Error(`The ${name} tunnel process exited (code ${state.exitCode}) before producing a URL. Last log lines:\n${tail}`)
        );
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for a tunnel URL in ${logPath}`));
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function rewriteEnvFile(path, updates) {
  let lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  lines = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq === -1) return line;
    const key = line.slice(0, eq);
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.filter((l, i, arr) => l !== "" || i === arr.length - 1).join("\n"));
}

function killPreviousTunnels() {
  // Every run starts fresh, random URLs — a previous run's tunnels are
  // always stale and only cause confusion (wrong URL still resolving,
  // stale CORS origin, etc.) if left running. cloudflared.exe here is
  // dedicated to this script, so it's safe to clear all instances of it.
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" /FO CSV /NH', { encoding: "utf8" });
    const pids = [...out.matchAll(/"cloudflared\.exe","(\d+)"/g)].map((m) => m[1]);
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`Stopped a previous tunnel (PID ${pid}).`);
      } catch {
        // already gone — fine
      }
    }
  } catch {
    // tasklist found nothing running — fine, nothing to clean up
  }
}

async function attemptTunnels() {
  const client = startTunnel("client", 5190);
  const server = startTunnel("server", 4000);
  const [clientUrl, serverUrl] = await Promise.all([waitForUrl(client), waitForUrl(server)]);
  return { client, server, clientUrl, serverUrl };
}

async function main() {
  killPreviousTunnels();
  console.log("Starting cloudflared tunnels (this can take a few seconds)...");

  let result;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await attemptTunnels();
      break;
    } catch (err) {
      console.error(`Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      killPreviousTunnels(); // clear whatever half-started this attempt before retrying
      if (attempt === MAX_ATTEMPTS) {
        console.error("");
        console.error("Cloudflare's quick-tunnel provisioning API didn't respond in time after several tries.");
        console.error("This is usually transient — wait a minute and re-run: node tools/tunnel.mjs");
        console.error("server/.env and client/.env.local were NOT changed.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const { client, server, clientUrl, serverUrl } = result;
  const clientHost = new URL(clientUrl).host;

  rewriteEnvFile(join(ROOT, "server", ".env"), {
    ORIGIN: clientUrl,
    RP_ID: clientHost,
    COOKIE_SAMESITE: "none",
    COOKIE_SECURE: "true",
  });
  rewriteEnvFile(join(ROOT, "client", ".env.local"), {
    VITE_API_BASE: serverUrl,
  });

  console.log("");
  console.log("Tunnels are up:");
  console.log(`  client (open this in your browser): ${clientUrl}`);
  console.log(`  server (API, no need to open):      ${serverUrl}`);
  console.log("");
  console.log(`  client tunnel pid: ${client.pid}  log: ${client.logPath}`);
  console.log(`  server tunnel pid: ${server.pid}  log: ${server.logPath}`);
  console.log("");
  console.log("server/.env and client/.env.local were updated. Now (re)start both dev servers:");
  console.log("  npm run dev --workspace server");
  console.log("  npm run dev --workspace client");
  console.log("");
  console.log(`Then open ${clientUrl}/enrol.html in your browser.`);
  console.log("");
  console.log("To stop the tunnels later:");
  console.log(`  taskkill /PID ${client.pid} /F`);
  console.log(`  taskkill /PID ${server.pid} /F`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
