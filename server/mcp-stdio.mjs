#!/usr/bin/env node
// Zero-dependency stdio MCP bridge for paseo-plugin-genui.
// Reads newline-delimited JSON-RPC 2.0 messages from stdin, forwards them to
// the Paseo plugin's localhost MCP bridge, and writes responses to stdout.
// Reads the live bridge URL/token from GENUI_MCP_DISCOVERY_FILE so resumed
// sessions keep working seamlessly across Paseo daemon restarts and plugin reloads.

import { readFileSync } from "node:fs";
import readline from "node:readline";

const discoveryFile = process.env.GENUI_MCP_DISCOVERY_FILE || "";
const fallbackUrl = process.env.GENUI_MCP_URL || "";
const fallbackToken = process.env.GENUI_MCP_TOKEN || "";
const cwd = process.env.GENUI_AGENT_CWD || "";
const storage = process.env.PASEO_THREAD_STORAGE || process.env.BB_THREAD_STORAGE || "";

function readEndpoint() {
  if (discoveryFile) {
    try {
      const raw = readFileSync(discoveryFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === "string" && typeof parsed.token === "string") {
        return { url: parsed.url, token: parsed.token };
      }
    } catch {
      // Fall back to env vars if discovery file is unavailable
    }
  }
  if (fallbackUrl && fallbackToken) {
    return { url: fallbackUrl, token: fallbackToken };
  }
  return null;
}

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function postToBridge(endpoint, msg) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${endpoint.token}`,
  };
  if (cwd) headers["x-genui-cwd"] = cwd;
  if (storage) headers["x-genui-storage"] = storage;

  return fetch(endpoint.url, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    writeResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const endpoint = readEndpoint();
  if (!endpoint) {
    if (msg && msg.id !== undefined) {
      writeResponse({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: "Gen-UI MCP bridge endpoint is not configured" },
      });
    }
    return;
  }

  try {
    let res = await postToBridge(endpoint, msg);

    // If the plugin reloaded with a new token/port, re-read discovery file and retry once.
    if (res.status === 401 && discoveryFile) {
      const refreshed = readEndpoint();
      if (refreshed && (refreshed.url !== endpoint.url || refreshed.token !== endpoint.token)) {
        res = await postToBridge(refreshed, msg);
      }
    }

    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (!text.trim()) return;
    process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    // Retry once with refreshed discovery file in case the bridge restarted on a new port.
    if (discoveryFile) {
      const refreshed = readEndpoint();
      if (refreshed && (refreshed.url !== endpoint.url || refreshed.token !== endpoint.token)) {
        try {
          const res = await postToBridge(refreshed, msg);
          if (res.status === 202 || res.status === 204) return;
          const text = await res.text();
          if (text.trim()) process.stdout.write(`${text.trim()}\n`);
          return;
        } catch {
          // Fall through to report original error
        }
      }
    }

    if (msg && msg.id !== undefined) {
      writeResponse({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: `Could not reach Paseo Gen-UI MCP bridge: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let queue = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(() => handleLine(line));
});
