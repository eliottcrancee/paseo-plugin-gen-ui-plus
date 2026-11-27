import { defineSettings } from "@getpaseo/plugin";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

export const genuiSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInstructions: z.boolean().default(true),
    instructionMode: z.enum(["mcp", "full"]).default("mcp"),
    webLookups: z.boolean().default(true),
    extraFolders: z.string().default(""),
    customMcpServersJson: z.string().default(""),
    disabledMcpServers: z.array(z.string()).default([]),
  }),
});

export function parseFolders(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((folder) => folder.trim())
    .filter((folder) => folder !== "");
}

export type ParsedMcpServersResult =
  | { readonly ok: true; readonly servers: Record<string, McpServerConfig> }
  | { readonly ok: false; readonly error: string };

export interface CustomMcpOAuthConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  readonly callbackPath?: string;
  readonly scope?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown, field: string, serverName: string): Record<string, string> | string {
  if (value === undefined) return {};
  if (!isRecord(value)) return `"${serverName}".${field} must be an object of strings`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return `"${serverName}".${field}.${k} must be a string`;
    out[k] = v;
  }
  return out;
}

/**
 * Parses a standard `mcpServers` JSON snippet (either `{ "mcpServers": { ... } }`
 * or a direct `{ "notion": { ... } }` object) into canonical Paseo `McpServerConfig` entries.
 */
export function parseCustomMcpServers(rawJson: string): ParsedMcpServersResult {
  const trimmed = rawJson.trim();
  if (trimmed === "") return { ok: true, servers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "Expected a JSON object mapping server names to configs." };
  }

  const root = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const servers: Record<string, McpServerConfig> = {};

  for (const [rawName, entry] of Object.entries(root)) {
    const name = rawName.trim();
    if (!name) continue;
    if (!isRecord(entry)) {
      return { ok: false, error: `Server "${name}" must be a JSON object.` };
    }

    const alwaysLoad = typeof entry.alwaysLoad === "boolean" ? entry.alwaysLoad : false;
    const rawType = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";

    if (rawType === "stdio" || (!rawType && typeof entry.command === "string")) {
      if (typeof entry.command !== "string" || entry.command.trim() === "") {
        return { ok: false, error: `Server "${name}" (stdio) requires a non-empty "command" string.` };
      }
      let args: string[] | undefined;
      if (entry.args !== undefined) {
        if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === "string")) {
          return { ok: false, error: `Server "${name}".args must be an array of strings.` };
        }
        args = entry.args;
      }
      const env = toStringRecord(entry.env, "env", name);
      if (typeof env === "string") return { ok: false, error: env };
      servers[name] = {
        type: "stdio",
        command: entry.command.trim(),
        ...(args ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        alwaysLoad,
      };
      continue;
    }

    if (rawType === "http" || rawType === "sse" || (!rawType && typeof entry.url === "string")) {
      if (typeof entry.url !== "string" || entry.url.trim() === "") {
        return { ok: false, error: `Server "${name}" requires a non-empty "url" string.` };
      }
      const headers = toStringRecord(entry.headers, "headers", name);
      if (typeof headers === "string") return { ok: false, error: headers };
      servers[name] = {
        type: rawType === "sse" ? "sse" : "http",
        url: entry.url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        alwaysLoad,
      };
      continue;
    }

    return {
      ok: false,
      error: `Server "${name}" must specify either "command" (stdio) or "url" (http/sse).`,
    };
  }

  return { ok: true, servers };
}

function expandString(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key: string) => env[key] ?? full);
}

function expandRecord(
  record: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = expandString(v, env);
  }
  return out;
}

/** Resolves enabled custom MCP servers and expands `${ENV_VAR}` templates against the host environment. */
export function resolveEnabledCustomMcpServers(
  rawJson: string,
  disabled: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Record<string, McpServerConfig> {
  const parsed = parseCustomMcpServers(rawJson);
  if (!parsed.ok) return {};
  const disabledSet = new Set(disabled);
  const out: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(parsed.servers)) {
    if (disabledSet.has(name)) continue;
    if (server.type === "stdio") {
      out[name] = {
        ...server,
        command: expandString(server.command, env),
        ...(server.args ? { args: server.args.map((a) => expandString(a, env)) } : {}),
        ...(server.env ? { env: expandRecord(server.env, env) } : {}),
      };
    } else {
      out[name] = {
        ...server,
        url: expandString(server.url, env),
        ...(server.headers ? { headers: expandRecord(server.headers, env) } : {}),
      };
    }
  }

  return out;
}

/**
 * Extracts optional per-server `oauth` blocks (`clientId`, `clientSecret`, `callbackPort`,
 * `callbackPath`, `scope`) from custom MCP JSON and expands `${ENV_VAR}` placeholders.
 */
export function resolveCustomMcpOAuthConfigs(
  rawJson: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Record<string, CustomMcpOAuthConfig> {
  const trimmed = rawJson.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const root = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const out: Record<string, CustomMcpOAuthConfig> = {};

  for (const [rawName, entry] of Object.entries(root)) {
    const name = rawName.trim();
    if (!name || !isRecord(entry) || !isRecord(entry.oauth)) continue;
    const oauth = entry.oauth;
    const clientId = typeof oauth.clientId === "string" && oauth.clientId.trim()
      ? expandString(oauth.clientId.trim(), env)
      : undefined;
    const clientSecret = typeof oauth.clientSecret === "string" && oauth.clientSecret.trim()
      ? expandString(oauth.clientSecret.trim(), env)
      : undefined;
    const callbackPort =
      typeof oauth.callbackPort === "number" && Number.isInteger(oauth.callbackPort) && oauth.callbackPort > 0 && oauth.callbackPort <= 65535
        ? oauth.callbackPort
        : undefined;
    const callbackPath =
      typeof oauth.callbackPath === "string" && oauth.callbackPath.trim()
        ? oauth.callbackPath.trim().startsWith("/")
          ? oauth.callbackPath.trim()
          : `/${oauth.callbackPath.trim()}`
        : undefined;
    const scope = typeof oauth.scope === "string" && oauth.scope.trim()
      ? expandString(oauth.scope.trim(), env)
      : undefined;

    if (clientId || clientSecret || callbackPort || callbackPath || scope) {
      out[name] = {
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(callbackPort ? { callbackPort } : {}),
        ...(callbackPath ? { callbackPath } : {}),
        ...(scope ? { scope } : {}),
      };
    }
  }
  return out;
}
