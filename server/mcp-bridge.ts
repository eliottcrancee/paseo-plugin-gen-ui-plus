import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import { handleMcpJsonRpc, type JsonRpcRequest, type McpDeps, type McpRequestContext } from "../shared/mcp";
import { packagePath } from "./data-source";

const MAX_BODY_BYTES = 128 * 1024;

export interface McpBridgeHandle {
  readonly url: string;
  readonly token: string;
  readonly discoveryFile: string | null;
  readonly stableStdioScript: string | null;
  close(): Promise<void>;
}

/**
 * Stable per-user directory for the MCP discovery file and stdio shim so
 * resumed sessions survive Paseo daemon restarts and plugin revision updates.
 */
function stableRuntimeDir(): string {
  const paseoDir = path.join(os.homedir(), ".paseo");
  if (existsSync(paseoDir)) return paseoDir;
  return os.tmpdir();
}

function writeDiscoveryFile(url: string, token: string): string | null {
  try {
    const dir = stableRuntimeDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "genui-mcp.json");
    writeFileSync(file, JSON.stringify({ url, token, pid: process.pid }), { encoding: "utf8", mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

function syncStableStdioScript(): string | null {
  const source = packagePath("server", "mcp-stdio.mjs");
  if (!existsSync(source)) return null;
  try {
    const dir = stableRuntimeDir();
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "genui-mcp-stdio.mjs");
    copyFileSync(source, target);
    return target;
  } catch {
    return source;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Starts a localhost-only MCP JSON-RPC HTTP server on an ephemeral port,
 * protected by a per-process random bearer token.
 */
export async function startMcpBridge(deps: McpDeps): Promise<McpBridgeHandle> {
  const token = randomBytes(24).toString("hex");

  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 405, { error: "Use POST for MCP JSON-RPC requests" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Request body too large" },
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const ctx: McpRequestContext = {
      cwd: singleHeader(req, "x-genui-cwd"),
      storageDir: singleHeader(req, "x-genui-storage"),
    };

    if (Array.isArray(parsed)) {
      const responses = (
        await Promise.all(parsed.map((item) => handleMcpJsonRpc((item ?? {}) as JsonRpcRequest, deps, ctx)))
      ).filter((item): item is NonNullable<typeof item> => item !== null);
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, 200, responses);
      return;
    }

    const response = await handleMcpJsonRpc((parsed ?? {}) as JsonRpcRequest, deps, ctx);
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const discoveryFile = writeDiscoveryFile(url, token);
  const stableStdioScript = syncStableStdioScript();

  return {
    url,
    token,
    discoveryFile,
    stableStdioScript,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function nvmNodeCandidates(home: string, binName: string): string[] {
  const versionsDir = path.join(home, ".nvm", "versions", "node");
  if (!existsSync(versionsDir)) return [];
  try {
    return readdirSync(versionsDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((ver) => path.join(versionsDir, ver, "bin", binName));
  } catch {
    return [];
  }
}

/**
 * Finds a JS runtime (`node` or `bun`) that can execute `server/mcp-stdio.mjs`.
 * - Pure npm/Node or Bun Paseo daemon: `process.execPath` is already `node`/`bun`.
 * - Paseo desktop app / standalone binary (macOS, Linux & Windows): `process.execPath`
 *   points to `paseo` itself, so we search `PATH` and standard OS install locations.
 * - If none is found, `buildMcpServerConfig` falls back to `type: "http"` directly.
 */
export function resolveNodeExecutable(): string | null {
  const execBase = path.basename(process.execPath);
  if (/^(node|bun)(\.exe)?$/i.test(execBase)) {
    return process.execPath;
  }

  const isWin = process.platform === "win32";
  const binName = isWin ? "node.exe" : "node";
  const bunName = isWin ? "bun.exe" : "bun";
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  const home = os.homedir();

  const platformCandidates: string[] = isWin
    ? [
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", binName),
        ...(process.env["ProgramFiles(x86)"]
          ? [path.join(process.env["ProgramFiles(x86)"], "nodejs", binName)]
          : []),
        ...(process.env.NVM_SYMLINK ? [path.join(process.env.NVM_SYMLINK, binName)] : []),
        ...(process.env.LOCALAPPDATA
          ? [
              path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", binName),
              path.join(process.env.LOCALAPPDATA, "Volta", "bin", binName),
              path.join(process.env.LOCALAPPDATA, "mise", "shims", binName),
            ]
          : []),
        path.join(home, "scoop", "shims", binName),
        path.join(home, ".volta", "bin", binName),
        path.join(home, ".bun", "bin", bunName),
      ]
    : [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/home/linuxbrew/.linuxbrew/bin/node",
        path.join(home, ".volta", "bin", binName),
        path.join(home, ".fnm", "current", "bin", binName),
        path.join(home, ".local", "share", "mise", "shims", binName),
        path.join(home, ".asdf", "shims", binName),
        ...nvmNodeCandidates(home, binName),
        path.join(home, ".bun", "bin", bunName),
      ];

  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, binName)),
    ...platformCandidates,
    ...pathDirs.map((dir) => path.join(dir, bunName)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Builds the canonical Paseo `McpServerConfig` for an agent session.
 * Prefers `stdio` with a resolved `node` executable (universal across Pi
 * pi-mcp-adapter lazy loading, OpenCode, Claude Code, and Codex) and falls back
 * to `http` if `node` or the bridge script is unavailable.
 */
export function buildMcpServerConfig(bridge: McpBridgeHandle, cwd?: string): McpServerConfig {
  const stdioScript = bridge.stableStdioScript ?? packagePath("server", "mcp-stdio.mjs");
  const nodeBin = resolveNodeExecutable();
  if (nodeBin !== null && existsSync(stdioScript)) {
    const env: Record<string, string> = {
      GENUI_MCP_URL: bridge.url,
      GENUI_MCP_TOKEN: bridge.token,
    };
    if (bridge.discoveryFile) env.GENUI_MCP_DISCOVERY_FILE = bridge.discoveryFile;
    if (cwd) env.GENUI_AGENT_CWD = cwd;
    return {
      type: "stdio",
      command: nodeBin,
      args: [stdioScript],
      env,
      alwaysLoad: false,
    };
  }

  return {
    type: "http",
    url: bridge.url,
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      ...(cwd ? { "X-Genui-Cwd": cwd } : {}),
    },
    alwaysLoad: false,
  };
}
