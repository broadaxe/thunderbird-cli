#!/usr/bin/env node
/**
 * Bridge auth test — spawns the REAL bridge/bridge.js (unlike quick-test.mjs
 * and mcp-test.mjs, which use inline mock bridges) and verifies:
 *
 *   - HTTP requests without a bearer token are rejected (401)
 *   - HTTP requests with a wrong token are rejected (401)
 *   - HTTP requests with the correct token succeed (200)
 *   - No Access-Control-* headers are served
 *   - WebSocket handshakes with an http(s) Origin are rejected (browser pages)
 *   - WebSocket handshakes without a web Origin connect (extension-style)
 *   - A second WS connection cannot displace a live one
 *
 * The token is injected via TB_AUTH_TOKEN so the test never touches
 * ~/.config/thunderbird-cli/config.json.
 */

import { spawn } from "child_process";
import { WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(__dirname, "..", "bridge", "bridge.js");

const PORT = 27700;
const WS_PORT = 27701;
const TOKEN = "test-token-bridge-auth-suite";

let passed = 0,
  failed = 0;

function test(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function wsAttempt(origin) {
  return new Promise((resolve) => {
    const opts = origin ? { headers: { Origin: origin } } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, opts);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ connected: false, error: "timeout" });
    }, 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ connected: true, ws });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      resolve({ connected: false, error: e.message });
    });
  });
}

async function main() {
  console.log("\n\x1b[1mBridge auth tests (real bridge/bridge.js)\x1b[0m\n");

  const proc = spawn("node", [BRIDGE_PATH, "--port", String(PORT), "--ws-port", String(WS_PORT)], {
    env: { ...process.env, TB_AUTH_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));

  // Wait for the bridge to listen
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${stderr}`)), 5000);
    proc.stdout.on("data", (d) => {
      if (d.toString().includes("HTTP server on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`bridge exited early (${code}): ${stderr}`)));
  });

  try {
    // ── HTTP auth ────────────────────────────────────────────────
    let res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`);
    test("no token → 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    test("wrong token → 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();
    test("correct token → 200", res.status === 200 && body.bridge === "running", `got ${res.status}`);

    // ── CORS absence ─────────────────────────────────────────────
    res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
    });
    const corsHeaders = [...res.headers.keys()].filter((h) => h.startsWith("access-control-"));
    test("no Access-Control-* headers", corsHeaders.length === 0, `found: ${corsHeaders.join(", ")}`);

    // ── WebSocket origin checks ──────────────────────────────────
    const browserAttempt = await wsAttempt("https://evil.example");
    test("WS with web Origin rejected", !browserAttempt.connected, "browser-origin handshake connected");

    const extAttempt = await wsAttempt(null);
    test("WS without web Origin connects (extension-style)", extAttempt.connected, extAttempt.error);

    // ── No displacement of a live connection ─────────────────────
    if (extAttempt.connected) {
      const second = await wsAttempt(null);
      test("second WS connection rejected while first is live", !second.connected, "displacement succeeded");
      if (second.connected) second.ws.close();
      extAttempt.ws.close();
    } else {
      test("second WS connection rejected while first is live", false, "skipped: first connection failed");
    }
  } finally {
    proc.kill();
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e.message);
  process.exit(1);
});
