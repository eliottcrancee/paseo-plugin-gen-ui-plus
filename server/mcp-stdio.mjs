#!/usr/bin/env node
// Zero-dependency stdio MCP bridge for paseo-plugin-genui.
// Reads newline-delimited JSON-RPC 2.0 messages from stdin, forwards them to
// the Paseo plugin's localhost MCP bridge, and writes responses to stdout.

import readline from "node:readline";

const url = process.env.GENUI_MCP_URL;
const token = process.env.GENUI_MCP_TOKEN;
const cwd = process.env.GENUI_AGENT_CWD || "";
const storage = process.env.PASEO_THREAD_STORAGE || process.env.BB_THREAD_STORAGE || "";

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
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

  if (!url || !token) {
    if (msg && msg.id !== undefined) {
      writeResponse({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: "GENUI_MCP_URL or GENUI_MCP_TOKEN is not configured" },
      });
    }
    return;
  }

  try {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    if (cwd) headers["x-genui-cwd"] = cwd;
    if (storage) headers["x-genui-storage"] = storage;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });

    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (!text.trim()) return;
    process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
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
