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

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function startTunnel(name, port) {
  const logPath = join(LOG_DIR, `${name}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  return { name, port, logPath, pid: child.pid };
}

function waitForUrl(logPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf8");
        const match = content.match(URL_RE);
        if (match) return resolve(match[0]);
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

async function main() {
  killPreviousTunnels();
  console.log("Starting cloudflared tunnels (this can take a few seconds)...");
  const client = startTunnel("client", 5190);
  const server = startTunnel("server", 4000);

  const [clientUrl, serverUrl] = await Promise.all([
    waitForUrl(client.logPath),
    waitForUrl(server.logPath),
  ]);

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
