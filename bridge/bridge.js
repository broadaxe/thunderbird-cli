#!/usr/bin/env node

/**
 * Thunderbird AI Bridge Server
 *
 * HTTP server (port 7700) for CLI requests.
 * WebSocket server (port 7701) for Thunderbird extension.
 * Forwards: CLI HTTP → WebSocket → Extension → response.
 *
 * Usage: node bridge.js [--port 7700] [--ws-port 7701]
 *
 * Environment variables:
 *   TB_BRIDGE_TIMEOUT  default per-request timeout in ms (default: 120000)
 *   TB_AUTH_TOKEN      bearer token required on every HTTP request
 *
 * Authentication:
 *   Every HTTP request must carry `Authorization: Bearer <token>`.
 *   The token is resolved from (in order): $TB_AUTH_TOKEN, then
 *   ~/.config/thunderbird-cli/config.json (bridge.authToken) — the same
 *   sources the CLI and MCP clients already read. If neither exists, a
 *   token is generated on startup and persisted to that config file so
 *   existing installs keep working without manual setup.
 *
 * Per-request override: HTTP clients can pass `X-TB-Timeout: <ms>` header.
 */

import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const HTTP_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "7700");
const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--ws-port") || "7701");
const DEFAULT_TIMEOUT = parseInt(process.env.TB_BRIDGE_TIMEOUT || "120000");

// ─── Auth token ─────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "thunderbird-cli", "config.json");

function loadOrCreateToken() {
  // 1. Environment wins
  if (process.env.TB_AUTH_TOKEN) return process.env.TB_AUTH_TOKEN;

  // 2. Config file (same file the CLI/MCP clients read)
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      console.error(`[bridge] WARNING: ${CONFIG_PATH} is not valid JSON; ignoring.`);
    }
  }
  const existing = cfg.bridge?.authToken || cfg.authToken;
  if (existing) return existing;

  // 3. Generate, persist, and tell the operator
  const token = randomBytes(32).toString("hex");
  cfg.bridge = { ...(cfg.bridge || {}), authToken: token };
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log(`[bridge] Generated auth token and saved to ${CONFIG_PATH}`);
    console.log(`[bridge] The tb CLI and MCP server read this file automatically.`);
  } catch (e) {
    console.error(`[bridge] FATAL: could not persist auth token to ${CONFIG_PATH}: ${e.message}`);
    console.error(`[bridge] Set TB_AUTH_TOKEN in the environment instead.`);
    process.exit(1);
  }
  return token;
}

const AUTH_TOKEN = loadOrCreateToken();
const AUTH_BUF = Buffer.from(AUTH_TOKEN);

function isAuthorized(req) {
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  // Timing-safe compare; length mismatch fails without leaking timing.
  return presented.length === AUTH_BUF.length && timingSafeEqual(presented, AUTH_BUF);
}

let extensionSocket = null;
const pending = new Map(); // id → { resolve, reject, timer }

// ─── WebSocket Server (for extension) ───────────────────────────────

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: WS_PORT,
  verifyClient: ({ req }, done) => {
    // Web pages always send an http(s) Origin on WebSocket handshakes;
    // the Thunderbird extension does not. WebSockets are not subject to
    // CORS, so without this check any open browser tab could connect.
    const origin = req.headers.origin || "";
    if (/^https?:\/\//i.test(origin)) {
      console.error(`[bridge] Rejected WS connection with web Origin: ${origin}`);
      return done(false, 403, "Forbidden");
    }
    // A live extension socket cannot be displaced by a new connection.
    if (extensionSocket && extensionSocket.readyState === 1) {
      console.error("[bridge] Rejected WS connection: extension already connected");
      return done(false, 409, "Already connected");
    }
    done(true);
  },
});

wss.on("connection", (ws) => {
  console.log("[bridge] Extension connected");
  extensionSocket = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(msg.error);
        } else {
          p.resolve(msg.result);
        }
      }
    } catch (e) {
      console.error("[bridge] Bad message from extension:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("[bridge] Extension disconnected");
    if (extensionSocket === ws) extensionSocket = null;
  });
});

// ─── Forward request to extension ───────────────────────────────────

function forwardToExtension(method, path, body, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject({ message: "Thunderbird extension not connected. Is Thunderbird running?" });
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({ message: `Request timed out (${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ id, method, path, body }));
  });
}

// ─── HTTP Server (for CLI) ──────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  // No CORS headers by design: the CLI and MCP server are not browsers.
  // Serving Access-Control-Allow-Origin from a localhost service lets
  // any open web page read mailbox data; see SECURITY.md.

  if (!isAuthorized(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized: missing or invalid bearer token" }));
    return;
  }

  // Bridge status endpoint (doesn't need extension)
  if (req.url === "/bridge/status") {
    const status = {
      bridge: "running",
      extension: extensionSocket ? "connected" : "disconnected",
      httpPort: HTTP_PORT,
      wsPort: WS_PORT,
      defaultTimeoutMs: DEFAULT_TIMEOUT,
    };
    res.writeHead(200);
    res.end(JSON.stringify(status));
    return;
  }

  // Read body
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsedBody = null;
  if (body.trim()) {
    try {
      parsedBody = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
  }

  // Per-request timeout override via X-TB-Timeout header
  let timeoutMs = DEFAULT_TIMEOUT;
  const headerTimeout = req.headers["x-tb-timeout"];
  if (headerTimeout) {
    const parsed = parseInt(headerTimeout);
    if (parsed > 0) timeoutMs = parsed;
  }

  // Forward to extension
  try {
    const result = await forwardToExtension(req.method, req.url, parsedBody, timeoutMs);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err.message?.includes("not connected") ? 503 : 500;
    res.writeHead(status);
    res.end(JSON.stringify({ error: err.message || "Unknown error" }));
  }
});

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`[bridge] HTTP server on http://127.0.0.1:${HTTP_PORT} (bearer auth required)`);
  console.log(`[bridge] WebSocket server on ws://127.0.0.1:${WS_PORT} (web origins rejected)`);
  console.log(`[bridge] Default timeout: ${DEFAULT_TIMEOUT}ms (override via TB_BRIDGE_TIMEOUT env or X-TB-Timeout header)`);
  console.log(`[bridge] Waiting for Thunderbird extension to connect...`);
});
