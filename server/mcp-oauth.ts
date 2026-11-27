import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredOAuthRecord {
  serverUrl: string;
  serverName: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
  updatedAt: number;
}

export interface OAuthStatusSummary {
  url: string;
  status: "connected" | "expired" | "pending" | "public" | "none";
  expiresAt?: number;
  hasRefreshToken?: boolean;
  lastError?: string;
}

export interface StaticOAuthOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  readonly callbackPath?: string;
  readonly scope?: string;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface PendingFlow {
  serverName: string;
  serverUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
  scope?: string;
  server: Server;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const DEFAULT_STORE_PATH = join(homedir(), ".paseo", "genui-mcp-oauth.json");
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_BUFFER_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

const pendingFlowsByUrl = new Map<string, PendingFlow>();
const lastErrorByUrl = new Map<string, string>();
const publicProbeCache = new Map<string, { isPublic: boolean; checkedAt: number }>();
const PUBLIC_PROBE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_PROBE_TIMEOUT_MS = 5_000;

async function probeMcpServer(serverUrl: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{
  status: number;
  wwwAuthenticate: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "paseo-gen-ui-plus", version: "0.5.1" },
        },
      }),
      signal: controller.signal,
    });
    return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") };
  } catch {
    return { status: 0, wwwAuthenticate: null };
  } finally {
    clearTimeout(timer);
  }
}

export function expandEnvInUrl(
  rawUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { url: string; missing: string[] } {
  const missing: string[] = [];
  const url = rawUrl.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key: string) => {
    const value = env[key];
    if (value === undefined || value === "") {
      missing.push(key);
      return full;
    }
    return value;
  });
  return { url, missing };
}

export function normalizeServerUrl(
  rawUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const expanded = expandEnvInUrl(rawUrl, env).url.trim();
  try {
    const parsed = new URL(expanded);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return expanded;
  }
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function parseWwwAuthenticate(header: string | null): {
  resourceMetadata?: string;
  scope?: string;
} {
  if (!header) return {};
  const result: { resourceMetadata?: string; scope?: string } = {};
  const rmMatch = /resource_metadata="([^"]+)"/i.exec(header);
  if (rmMatch?.[1]) result.resourceMetadata = rmMatch[1];
  const scopeMatch = /scope="([^"]+)"/i.exec(header);
  if (scopeMatch?.[1]) result.scope = scopeMatch[1];
  return result;
}

function readStore(storePath = DEFAULT_STORE_PATH): Record<string, StoredOAuthRecord> {
  if (!existsSync(storePath)) return {};
  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredOAuthRecord>;
  } catch {
    return {};
  }
}

function writeStore(records: Record<string, StoredOAuthRecord>, storePath = DEFAULT_STORE_PATH): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore chmod failures on filesystems that don't support POSIX modes.
  }
  renameSync(tmpPath, storePath);
}

async function fetchJsonWithTimeout<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data?: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function discoverProtectedResource(
  serverUrl: string,
  hintedUrl?: string,
): Promise<{ metadata: ProtectedResourceMetadata | null; scopeFromHeader?: string }> {
  const parsed = new URL(serverUrl);
  const candidates: string[] = [];
  if (hintedUrl) candidates.push(hintedUrl);
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (cleanPath && cleanPath !== "/") {
    candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource${cleanPath}`);
  }
  candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource`);

  for (const candidate of candidates) {
    const res = await fetchJsonWithTimeout<ProtectedResourceMetadata>(candidate, {
      headers: { Accept: "application/json" },
    });
    if (res.ok && res.data && typeof res.data === "object") {
      return { metadata: res.data };
    }
  }
  return { metadata: null };
}

async function discoverAuthServer(authServerUrl: string): Promise<AuthServerMetadata> {
  const parsed = new URL(authServerUrl);
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const candidates: string[] = [];
  if (cleanPath && cleanPath !== "/") {
    candidates.push(`${parsed.origin}/.well-known/oauth-authorization-server${cleanPath}`);
    candidates.push(`${parsed.origin}/.well-known/openid-configuration${cleanPath}`);
    candidates.push(`${parsed.origin}${cleanPath}/.well-known/openid-configuration`);
  }
  candidates.push(`${parsed.origin}/.well-known/oauth-authorization-server`);
  candidates.push(`${parsed.origin}/.well-known/openid-configuration`);

  for (const candidate of candidates) {
    const res = await fetchJsonWithTimeout<Partial<AuthServerMetadata>>(candidate, {
      headers: { Accept: "application/json" },
    });
    if (res.ok && res.data?.authorization_endpoint && res.data?.token_endpoint) {
      return {
        issuer: res.data.issuer,
        authorization_endpoint: res.data.authorization_endpoint,
        token_endpoint: res.data.token_endpoint,
        registration_endpoint: res.data.registration_endpoint,
        scopes_supported: res.data.scopes_supported,
      };
    }
  }

  // RFC / MCP 2025-03-26 fallback endpoints when metadata is unavailable.
  return {
    authorization_endpoint: `${parsed.origin}/authorize`,
    token_endpoint: `${parsed.origin}/token`,
    registration_endpoint: `${parsed.origin}/register`,
  };
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_name: "Paseo Gen-UI Plus",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Dynamic client registration failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { client_id?: string; client_secret?: string };
    if (!body.client_id) {
      throw new Error("Dynamic client registration did not return a client_id.");
    }
    return {
      clientId: body.client_id,
      ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeToken(params: {
  tokenEndpoint: string;
  body: URLSearchParams;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(params.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Token request failed (${res.status}): ${text.slice(0, 240)}`);
    }
    const json = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new Error("Token response did not contain access_token.");
    }
    const expiresAt =
      typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0
        ? Date.now() + json.expires_in * 1000
        : undefined;
    return {
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      ...(json.token_type ? { tokenType: json.token_type } : {}),
      ...(json.scope ? { scope: json.scope } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

function openExternalUrl(url: string): void {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    } else if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      child.unref();
    } else {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch {
    // Non-fatal: the UI also displays the link so the user can open it manually.
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCallbackPage(ok: boolean, title: string, detail: string): string {
  const accent = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #181b24; border: 1px solid #2b3040; border-radius: 12px; padding: 28px 32px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.4); }
    .badge { display: inline-block; width: 40px; height: 40px; line-height: 40px; border-radius: 999px; background: ${accent}; color: #fff; font-weight: 700; font-size: 20px; margin-bottom: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 13.5px; color: #9ca3af; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${ok ? "✓" : "!"}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
}

function closePendingFlow(key: string): void {
  const existing = pendingFlowsByUrl.get(key);
  if (!existing) return;
  pendingFlowsByUrl.delete(key);
  clearTimeout(existing.timeout);
  try {
    existing.server.close();
  } catch {
    // Ignore close errors.
  }
}

async function finishPendingFlow(
  flow: PendingFlow,
  code: string,
  storePath = DEFAULT_STORE_PATH,
): Promise<void> {
  const key = normalizeServerUrl(flow.serverUrl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
  });
  if (flow.clientSecret) body.set("client_secret", flow.clientSecret);
  if (flow.resource) body.set("resource", flow.resource);

  const tokens = await exchangeToken({ tokenEndpoint: flow.tokenEndpoint, body });
  const records = readStore(storePath);
  records[key] = {
    serverUrl: key,
    serverName: flow.serverName,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
    ...(tokens.scope ?? flow.scope ? { scope: tokens.scope ?? flow.scope } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    tokenEndpoint: flow.tokenEndpoint,
    clientId: flow.clientId,
    ...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
    ...(flow.resource ? { resource: flow.resource } : {}),
    updatedAt: Date.now(),
  };
  writeStore(records, storePath);
  lastErrorByUrl.delete(key);
}

/**
 * Starts a standard MCP OAuth 2.1 + PKCE + Dynamic Client Registration flow
 * with a local ephemeral 127.0.0.1 callback server, opens the user's browser,
 * and returns the authorization URL for fallback display in Paseo.
 */
export async function startMcpOAuthFlow(
  serverName: string,
  rawUrl: string,
  options?: StaticOAuthOptions,
  storePath = DEFAULT_STORE_PATH,
): Promise<{ ok: true; authUrl?: string; noAuthRequired?: boolean } | { ok: false; error: string }> {
  const { missing } = expandEnvInUrl(rawUrl);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing environment variable${missing.length === 1 ? "" : "s"} in Paseo daemon: ${missing.join(", ")}`,
    };
  }
  const serverUrl = normalizeServerUrl(rawUrl);
  try {
    new URL(serverUrl);
  } catch {
    return { ok: false, error: `Invalid server URL: "${rawUrl}"` };
  }

  closePendingFlow(serverUrl);
  lastErrorByUrl.delete(serverUrl);

  try {
    // Step 1: Probe MCP server — detect public (no-auth) servers and inspect WWW-Authenticate hints (RFC 9728).
    let resourceMetadataHint: string | undefined;
    let scopeHint: string | undefined;
    const probe = await probeMcpServer(serverUrl, FETCH_TIMEOUT_MS);
    if (probe.status >= 200 && probe.status < 300) {
      publicProbeCache.set(serverUrl, { isPublic: true, checkedAt: Date.now() });
      return { ok: true, noAuthRequired: true };
    }
    if (probe.status === 401) {
      publicProbeCache.set(serverUrl, { isPublic: false, checkedAt: Date.now() });
      const parsedAuth = parseWwwAuthenticate(probe.wwwAuthenticate);
      resourceMetadataHint = parsedAuth.resourceMetadata;
      scopeHint = parsedAuth.scope;
    }

    // Step 2: Discover Protected Resource & Authorization Server metadata.
    const { metadata: prm } = await discoverProtectedResource(serverUrl, resourceMetadataHint);
    const authServerUrl = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
    const asm = await discoverAuthServer(authServerUrl);
    const resource = prm?.resource ?? serverUrl;
    const scope =
      options?.scope ??
      scopeHint ??
      (prm?.scopes_supported?.length ? prm.scopes_supported.join(" ") : undefined) ??
      (asm.scopes_supported?.length ? asm.scopes_supported.join(" ") : undefined);

    // Step 3: Start loopback callback server on 127.0.0.1 (custom port/path or ephemeral).
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = base64Url(randomBytes(24));
    const callbackPath = options?.callbackPath
      ? options.callbackPath.startsWith("/")
        ? options.callbackPath
        : `/${options.callbackPath}`
      : "/oauth/callback";
    const requestedPort = options?.callbackPort ?? 0;

    let flowRef: PendingFlow | null = null;
    const callbackServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const host = req.headers.host ?? "127.0.0.1";
      const reqUrl = new URL(req.url ?? "/", `http://${host}`);
      if (reqUrl.pathname !== callbackPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const returnedState = reqUrl.searchParams.get("state");
      const errorParam = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description");
      const code = reqUrl.searchParams.get("code");

      if (!flowRef || returnedState !== flowRef.state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderCallbackPage(false, "Invalid OAuth state", "Please restart sign-in from Paseo."));
        return;
      }

      if (errorParam) {
        const msg = errorDesc ? `${errorParam}: ${errorDesc}` : errorParam;
        lastErrorByUrl.set(serverUrl, msg);
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderCallbackPage(false, "Authorization declined", msg));
        closePendingFlow(serverUrl);
        return;
      }

      if (!code) {
        lastErrorByUrl.set(serverUrl, "Missing authorization code in callback.");
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderCallbackPage(false, "Missing authorization code", "Please try signing in again from Paseo."));
        closePendingFlow(serverUrl);
        return;
      }

      const activeFlow = flowRef;
      void finishPendingFlow(activeFlow, code, storePath)
        .then(() => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            renderCallbackPage(
              true,
              `Connected to ${activeFlow.serverName}`,
              "Authentication succeeded. You can close this tab and return to Paseo — start a new session to use it.",
            ),
          );
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          lastErrorByUrl.set(serverUrl, msg);
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(renderCallbackPage(false, "Token exchange failed", msg));
        })
        .finally(() => {
          closePendingFlow(serverUrl);
        });
    });

    const port = await new Promise<number>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(requestedPort, "127.0.0.1", () => {
        const addr = callbackServer.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Could not determine local OAuth callback port."));
        }
      });
    });

    const redirectUri = `http://127.0.0.1:${port}${callbackPath}`;

    // Step 4: Use pre-configured static OAuth client (e.g. Snowflake) or Dynamic Client Registration (RFC 7591).
    let clientId: string;
    let clientSecret: string | undefined;
    if (options?.clientId) {
      const missingClientVars = [
        ...expandEnvInUrl(options.clientId).missing,
        ...(options.clientSecret ? expandEnvInUrl(options.clientSecret).missing : []),
      ];
      if (missingClientVars.length > 0) {
        callbackServer.close();
        return {
          ok: false,
          error: `Missing OAuth environment variable${missingClientVars.length === 1 ? "" : "s"} in Paseo daemon: ${[...new Set(missingClientVars)].join(", ")}`,
        };
      }
      clientId = options.clientId;
      clientSecret = options.clientSecret;
    } else {
      if (!asm.registration_endpoint) {
        callbackServer.close();
        return {
          ok: false,
          error:
            'Server does not support Dynamic Client Registration. Add "oauth": { "clientId": "...", "clientSecret": "...", "callbackPort": 19876, "callbackPath": "/oauth/callback" } in raw JSON.',
        };
      }
      try {
        const reg = await registerDynamicClient(asm.registration_endpoint, redirectUri);
        clientId = reg.clientId;
        clientSecret = reg.clientSecret;
      } catch (err) {
        callbackServer.close();
        throw err;
      }
    }

    // Step 5: Build authorization URL with PKCE S256.
    const authUrlObj = new URL(asm.authorization_endpoint);
    authUrlObj.searchParams.set("response_type", "code");
    authUrlObj.searchParams.set("client_id", clientId);
    authUrlObj.searchParams.set("redirect_uri", redirectUri);
    authUrlObj.searchParams.set("code_challenge", codeChallenge);
    authUrlObj.searchParams.set("code_challenge_method", "S256");
    authUrlObj.searchParams.set("state", state);
    if (scope) authUrlObj.searchParams.set("scope", scope);
    if (resource) authUrlObj.searchParams.set("resource", resource);

    const timeout = setTimeout(() => {
      lastErrorByUrl.set(serverUrl, "OAuth sign-in timed out after 5 minutes.");
      closePendingFlow(serverUrl);
    }, PENDING_TIMEOUT_MS);

    flowRef = {
      serverName,
      serverUrl,
      state,
      codeVerifier,
      redirectUri,
      tokenEndpoint: asm.token_endpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(resource ? { resource } : {}),
      ...(scope ? { scope } : {}),
      server: callbackServer,
      timeout,
      createdAt: Date.now(),
    };
    pendingFlowsByUrl.set(serverUrl, flowRef);

    const authUrl = authUrlObj.toString();
    openExternalUrl(authUrl);
    return { ok: true, authUrl };
  } catch (err) {
    closePendingFlow(serverUrl);
    const message = err instanceof Error ? err.message : String(err);
    lastErrorByUrl.set(serverUrl, message);
    return { ok: false, error: message };
  }
}

export function getMcpOAuthStatuses(
  urls: readonly string[],
  storePath = DEFAULT_STORE_PATH,
): Record<string, OAuthStatusSummary> {
  const records = readStore(storePath);
  const out: Record<string, OAuthStatusSummary> = {};
  const now = Date.now();

  for (const rawUrl of urls) {
    const key = normalizeServerUrl(rawUrl);
    if (pendingFlowsByUrl.has(key)) {
      out[rawUrl] = { url: rawUrl, status: "pending" };
      continue;
    }
    const record = records[key];
    if (!record) {
      const cachedPublic = publicProbeCache.get(key);
      if (cachedPublic?.isPublic && now - cachedPublic.checkedAt < PUBLIC_PROBE_TTL_MS) {
        out[rawUrl] = { url: rawUrl, status: "public" };
        continue;
      }
      const lastError = lastErrorByUrl.get(key);
      out[rawUrl] = {
        url: rawUrl,
        status: "none",
        ...(lastError ? { lastError } : {}),
      };
      continue;
    }
    const isExpired = typeof record.expiresAt === "number" && record.expiresAt <= now;
    out[rawUrl] = {
      url: rawUrl,
      status: isExpired && !record.refreshToken ? "expired" : "connected",
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      hasRefreshToken: Boolean(record.refreshToken),
    };
  }

  return out;
}

/**
 * Probes any unauthenticated (`none`) MCP URLs (cached 10m) so public servers
 * like `https://mcp.pola.rs/mcp` automatically report `status: "public"`.
 */
export async function getMcpOAuthStatusesWithProbe(
  urls: readonly string[],
  probePublic = false,
  storePath = DEFAULT_STORE_PATH,
): Promise<Record<string, OAuthStatusSummary>> {
  const initial = getMcpOAuthStatuses(urls, storePath);
  if (!probePublic) return initial;

  const now = Date.now();
  const toProbe = urls.filter((rawUrl) => {
    if (initial[rawUrl]?.status !== "none") return false;
    const { missing } = expandEnvInUrl(rawUrl);
    if (missing.length > 0) return false;
    const key = normalizeServerUrl(rawUrl);
    const cached = publicProbeCache.get(key);
    return !cached || now - cached.checkedAt >= PUBLIC_PROBE_TTL_MS;
  });

  if (toProbe.length === 0) return initial;

  await Promise.all(
    toProbe.map(async (rawUrl) => {
      const key = normalizeServerUrl(rawUrl);
      const res = await probeMcpServer(key, PUBLIC_PROBE_TIMEOUT_MS);
      if (res.status >= 200 && res.status < 300) {
        publicProbeCache.set(key, { isPublic: true, checkedAt: Date.now() });
        lastErrorByUrl.delete(key);
      } else if (res.status === 401 || res.status === 403) {
        publicProbeCache.set(key, { isPublic: false, checkedAt: Date.now() });
      }
    }),
  );

  return getMcpOAuthStatuses(urls, storePath);
}

/**
 * Returns a valid OAuth access token for the given MCP server URL,
 * automatically refreshing via `refresh_token` if the access token is near expiry.
 */
export async function getValidMcpOAuthToken(
  rawUrl: string,
  storePath = DEFAULT_STORE_PATH,
): Promise<string | null> {
  const key = normalizeServerUrl(rawUrl);
  const records = readStore(storePath);
  const record = records[key];
  if (!record?.accessToken) return null;

  const needsRefresh =
    typeof record.expiresAt === "number" && record.expiresAt - Date.now() <= REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return record.accessToken;
  }

  if (!record.refreshToken || !record.tokenEndpoint) {
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refreshToken,
      client_id: record.clientId,
    });
    if (record.clientSecret) body.set("client_secret", record.clientSecret);
    if (record.resource) body.set("resource", record.resource);

    const refreshed = await exchangeToken({ tokenEndpoint: record.tokenEndpoint, body });
    const updated: StoredOAuthRecord = {
      ...record,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? record.refreshToken,
      tokenType: refreshed.tokenType ?? record.tokenType,
      scope: refreshed.scope ?? record.scope,
      expiresAt: refreshed.expiresAt,
      updatedAt: Date.now(),
    };
    records[key] = updated;
    writeStore(records, storePath);
    return updated.accessToken;
  } catch {
    return null;
  }
}

export function clearMcpOAuthToken(rawUrl: string, storePath = DEFAULT_STORE_PATH): boolean {
  const key = normalizeServerUrl(rawUrl);
  closePendingFlow(key);
  lastErrorByUrl.delete(key);
  const records = readStore(storePath);
  if (!(key in records)) return false;
  delete records[key];
  writeStore(records, storePath);
  return true;
}

export function stopAllMcpOAuthFlows(): void {
  for (const key of Array.from(pendingFlowsByUrl.keys())) {
    closePendingFlow(key);
  }
}
